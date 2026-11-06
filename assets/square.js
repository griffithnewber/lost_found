/**
 * assets/square.js —— 广场（A 拥有）
 *
 * 为什么单独做：原来「我的发布」错把所有记录都列了出来，看着像广场；
 * 按归属过滤后，别的浏览器就什么都看不到了。这里给一个真正的公共列表：
 *   - 展示所有未被认领的失物（status: open / claimed）
 *   - 只显示公开字段：名称、缩略图、AI 特征描述、发布时间
 *   - 隐藏细节（detail）与具体位置（location）一律不出现
 *   - 已找回（returned）的自动不出现
 *
 * 对外接口：
 *   LF.square.render()       重新拉取并渲染（切到广场 tab、点刷新时调用）
 *   LF.square.bindByCode(x)  按编号（LF-18 / 18）把无归属记录绑到当前账号
 */
(function () {
  'use strict';

  LF.square = {};

  var all = [];        // 云端拉回来的全部可见物品
  var keyword = '';    // 当前筛选词

  function el(id) { return document.getElementById(id); }

  function statusBadge(it) {
    var type = it.postType === 'found' ? '拾者发布' : '失者发布';
    var state = it.status === 'claimed'
      ? ' <span class="badge score">已有人认领</span>'
      : ' <span class="badge">待认领</span>';
    return ' <span class="badge badge-type">' + type + '</span>' + state;
  }

  function match(it) {
    if (!keyword) return true;
    var cat = LF.ui.categoryMeta(it.category);
    // 只按「用户自己的话 + 类别」筛，绝不使用 AI 描述（AI 只在后台算分，不上前台）
    var hay = [it.title, it.notice, cat.label].filter(Boolean).join(' ').toLowerCase();
    return hay.indexOf(keyword.toLowerCase()) >= 0;
  }

  function draw() {
    var box = el('square-list');
    var countEl = el('square-count');
    if (!box) return;

    var rows = all.filter(match);
    if (countEl) {
      countEl.textContent = keyword
        ? '筛选出 ' + rows.length + ' 件 / 共 ' + all.length + ' 件'
        : '共 ' + all.length + ' 件待认领';
    }

    if (!rows.length) {
      box.innerHTML = '<div class="empty">' +
        (all.length ? '没有匹配的物品，换个词试试' : '广场上还没有失物') +
        '</div>';
      return;
    }

    box.innerHTML = rows.map(function (it) {
      var cat = LF.ui.categoryMeta(it.category);
      var isFound = it.postType === 'found';
      var hint = isFound
        ? '🔒 具体特征待核验后由拾者告知'
        : '🔒 隐藏细节与具体位置需通过核验后由发布者告知';
      return '' +
        '<div class="item square-item" id="item-' + it.id + '">' +
        LF.ui.thumbHTML(it) +
        '<div class="item-body">' +
        '<div class="item-title">' + LF.ui.esc(LF.ui.displayTitle(it)) + statusBadge(it) + '</div>' +
        '<div class="item-meta">' + LF.ui.esc(it.time || '') +
        (isFound && cat.label ? ' · ' + cat.emoji + ' ' + LF.ui.esc(cat.label) : '') + '</div>' +
        LF.ui.noticeHTML(it) +
        '<div class="item-desc muted">' + hint + '</div>' +
        '<div class="square-ops">' +
        '<button class="ghost" data-claim="' + it.id + '">' + (isFound ? '我要认领' : '这是我丢的') + '</button>' +
        '<button class="ghost" data-contact="' + it.id + '">' + (isFound ? '✉️ 联系拾者' : '✉️ 联系失主') + '</button>' +
        (it.image ? '' : '<button class="ghost" data-addphoto="' + it.id + '">📷 补张照片</button>') +
        '</div>' +
        '</div></div>';
    }).join('');
  }

  /* ================================================================
   * 补照片：统一入口（广场卡片 + 「我的发布」卡片共用）
   *
   * 为什么需要：智能体只能写文字，它登记的记录 image 是空的。之前补图
   * 只能在广场上点——但用户绑定编号后最常去的是「我的发布」，那里没有
   * 入口就得折回广场找，闭环断在半路。现在「我的发布」也渲染补图按钮，
   * 都走这一个方法；item 先从广场缓存找，找不到再按 id 拉一次库。
   * 规则和发布流程保持一致：
   *   先压缩（480 / JPEG 0.75）→ 从压缩图算颜色特征 → 拾者记录再模糊
   * 原图始终不出本机；颜色特征留在库里供图像检索用。
   * ================================================================ */

  /** 任何地方（广场 / 我的发布）点「📷 补张照片」都走这里 */
  LF.square.addPhotoById = async function (id) {
    var item = all.filter(function (x) { return x.id === id; })[0];
    if (!item) item = await LF.api.findItemById(id);   // 「我的发布」场景：广场缓存里可能有，也可能没有
    if (!item) { LF.ui.toast('没有找到这条记录', 'error', 3000); return; }
    LF.auth.require('补照片前先登录一下，免得有人改别人的记录', function () {
      pickPhoto(item);
    });
  };

  function pickPhoto(item) {
    if (!item) return;
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      if (inp.parentNode) document.body.removeChild(inp);
      if (f) attachPhoto(item, f);
    });
    inp.click();
  }

  async function attachPhoto(item, file) {
    if (!/^image\//.test(file.type)) {
      LF.ui.toast('请选择图片文件（jpg / png / webp）', 'error');
      return;
    }
    LF.ui.toast('正在处理照片…', 'info', 1200);
    try {
      var raw = await LF.ui.fileToDataURL(file);
      var image = await LF.ui.compressImage(raw);
      var feat = await LF.ui.extractColorFeature(image);   // 特征从压缩图算，够用且省内存
      // 拾者记录对外只放模糊图：广场的意义是"知道我捡到了什么"，不是"看清它的独特征"
      if (item.postType === 'found') image = await LF.ui.blurImage(image, 320);
      var res = await LF.api.updateItem(item.id, { image: image, colorFeature: feat });
      if (!res.ok) {
        LF.ui.toast('补图失败：' + (res.error || '未知错误'), 'error', 3000);
        return;
      }

      /* 补图后顺手确认归属。
       * 智能体登记的记录 owner_id 是空的——不绑的话「我的发布」看不到、
       * 别人留言也进不了自己信箱，整条闭环断在最后一步。所以这里问一句，
       * 用户点确认就当场绑上；点取消也不影响补图本身。 */
      if (!item.ownerId && LF.auth.userId()) {
        var wantBind = window.confirm(
          '照片已补上。\n\n' +
          '这条记录还不知道是谁登记的（智能体登记时拿不到你的账号）。\n' +
          '要绑到你的账号吗？绑定后，别人给你的留言会出现在你的信箱。'
        );
        if (wantBind) {
          var b = await LF.api.bindItemOwner(item.id);
          if (b.ok) LF.ui.toast('照片已补上，这条记录已归到你名下', 'success', 2600);
          else LF.ui.toast('照片已补上，但绑定失败：' + (b.error || '未知错误'), 'error', 3500);
        } else {
          LF.ui.toast('照片已补上（这条仍是无归属记录，别人留言你收不到）', 'info', 3600);
        }
      } else {
        LF.ui.toast('照片已补上', 'success');
      }

      document.dispatchEvent(new CustomEvent('lf:changed'));   // 广场 + 「我的发布」一起刷新
      waitAndFocus(item.id);
    } catch (e) {
      console.error('[square] attachPhoto failed', e);
      LF.ui.toast('补图失败，换一张试试', 'error', 3000);
    }
  }

  /* ================================================================
   * 编号绑定 + 链接直达
   *
   * 智能体登记时没有登录身份，写进去的记录 owner_id 是空的。这条记录在广场上
   * 看得见、能被留言，但「谁发的」是空的：补图不算自己发的、我的发布里没有、
   * 别人留言也进不了自己信箱——闭环就断在这里。
   *
   * 所以给两个入口把归属补回来：
   *   ① 广场顶部输入编号（LF-18 / 18）→ 绑到当前账号
   *   ② 智能体给的 #item-<id> 直达链接 → 卡片闪一下并浮出「绑到我账号」
   * ================================================================ */

  function parseCode(raw) {
    var m = /(\d+)/.exec(String(raw || ''));
    return m ? Number(m[1]) : null;
  }

  function jumpTo(id) {
    var card = el('item-' + id);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('flash');
    setTimeout(function () { card.classList.remove('flash'); }, 3600);
    offerBind(card, id);
  }

  /** 渲染是异步的，卡片可能还没出来，轮询等它（最多约 4 秒） */
  function waitAndFocus(id, tries) {
    tries = tries || 0;
    if (el('item-' + id)) { jumpTo(id); return; }
    if (tries < 26) setTimeout(function () { waitAndFocus(id, tries + 1); }, 150);
  }

  /** 无归属的记录在卡片里浮一条提示，一键绑给当前登录账号 */
  function offerBind(card, id) {
    if (!card || card.querySelector('.bind-bar')) return;
    var item = all.filter(function (x) { return x.id === id; })[0];
    if (!item || item.ownerId) return;         // 已有归属，不打扰
    if (!LF.auth.userId()) return;             // 未登录：等他登录后重新点链接
    var bar = document.createElement('div');
    bar.className = 'bind-bar';
    bar.innerHTML = '<span>📌 这条记录还没有归属。是你登记 / 捡到的吗？</span>' +
      '<button class="ghost" data-bind-owner="' + id + '">绑到我账号</button>';
    (card.querySelector('.item-body') || card).appendChild(bar);
  }

  /**
   * 按编号绑定：LF-18、lf18、18 都认
   * 绑定成功后这条记录就归当前账号，「我的发布」和信箱都能认到它。
   */
  LF.square.bindByCode = async function (raw) {
    var id = parseCode(raw);
    if (!id) { LF.ui.toast('编号长这样：LF-18，或者直接填 18', 'error', 3000); return false; }
    if (!LF.auth.userId()) {
      LF.auth.require('绑定前先登录，绑好之后这条才算你发的', function () { LF.square.bindByCode(raw); });
      return false;
    }
    var res = await LF.api.bindItemOwner(id);
    if (!res.ok) {
      if (res.code === 'nologin') {
        LF.auth.require('绑定前先登录', function () { LF.square.bindByCode(raw); });
        return false;
      }
      LF.ui.toast(res.error || '绑定失败', 'error', 3500);
      return false;
    }
    LF.ui.toast(res.already ? '这条本来就在你名下' : '✅ 已绑到你账号，之后有人留言会进你的信箱', 'success', 3200);
    ['bind-code', 'bind-code-home'].forEach(function (k) {
      var inp = el(k);
      if (inp) inp.value = '';
    });
    await LF.square.render();
    waitAndFocus(id);
    return true;
  };

  function focusFromHash() {
    var m = /^#item-(\d+)$/.exec(location.hash || '');
    if (!m) return;
    var id = Number(m[1]);
    var tab = document.querySelector('.tab[data-tab="square"]');
    if (tab) tab.click();
    waitAndFocus(id);
  }

  LF.square.render = async function () {
    var box = el('square-list');
    if (box) box.innerHTML = '<div class="empty">正在加载广场…</div>';
    var items = await LF.api.listPublicItems();
    // 只取最新 60 条，避免图片太多拖慢首屏
    all = items.slice(0, 60);
    draw();
  };

  function bind() {
    var input = el('square-search');
    if (input) {
      var timer = null;
      input.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(function () { keyword = input.value.trim(); draw(); }, 180);
      });
    }

    var btn = el('btn-square-refresh');
    if (btn) btn.addEventListener('click', async function () {
      btn.disabled = true; btn.textContent = '⏳ 刷新中…';
      await LF.square.render();
      btn.disabled = false; btn.textContent = '🔄 刷新广场';
      LF.ui.toast('广场已刷新', 'success', 1500);
    });

    // 切到广场 tab 时拉最新（tab 切换本身由 app.js 处理，这里只补数据）
    var tab = document.querySelector('.tab[data-tab="square"]');
    if (tab) tab.addEventListener('click', function () { LF.square.render(); });

    // 认领/留言处理完（留言会广播 lf:changed）后刷新广场状态
    document.addEventListener('lf:changed', function () { LF.square.render(); });

    // 补照片：登录后才能补，避免有人随手改别人的记录（广场 + 我的发布共用 addPhotoById）
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-addphoto]');
      if (!btn) return;
      LF.square.addPhotoById(Number(btn.getAttribute('data-addphoto')));
    });

    // 编号绑定：智能体给的 LF-xx 在这里换回归属（广场顶部 + 首页各一个入口）
    [['bind-code', 'btn-bind-code'], ['bind-code-home', 'btn-bind-code-home']].forEach(function (pair) {
      var inp = el(pair[0]);
      var btn = el(pair[1]);
      if (btn) btn.addEventListener('click', function () {
        LF.square.bindByCode(inp ? inp.value : '');
      });
      if (inp) inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); LF.square.bindByCode(inp.value); }
      });
    });

    // 卡片里浮出的「绑到我账号」
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-bind-owner]');
      if (!b) return;
      LF.square.bindByCode(b.getAttribute('data-bind-owner'));
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    bind();
    LF.square.render();   // 首页就预热一次，切过去不空
    setTimeout(focusFromHash, 600);   // 等首屏渲染完再处理 #item-<id> 直达
  });
})();
