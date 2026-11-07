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
  // 已找回提示卡的「粘性状态」：轮询重绘会把 DOM 清掉，靠这个在 draw() 后补回来
  var returnedSticky = null;

  function el(id) { return document.getElementById(id); }

  function statusBadge(it) {
    var type = it.postType === 'found' ? '拾者发布' : '失者发布';
    var state = it.status === 'claimed'
      ? ' <span class="badge score">已有人认领</span>'
      : ' <span class="badge">待认领</span>';
    return ' <span class="badge badge-type">' + type + '</span>' + state;
  }

  /** 寄存点标签：只有登记时填了 pickup_location 才出现（阿寻登记时会写） */
  function pickupHTML(it) {
    if (!it.pickupLocation) return '';
    return '<div class="pickup-tag">📍 可到「' + LF.ui.esc(it.pickupLocation) + '」认领</div>';
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
      paintReturnedCard(false);
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
        pickupHTML(it) +
        '<div class="item-desc muted">' + hint + '</div>' +
        '<div class="square-ops">' +
        // 认领核验已搬到聊天框：这里只给入口提示，不再弹网页 AI 问答
        '<button class="ghost" data-claim="' + it.id + '">' +
        LF.ui.esc((LF.config.agent && LF.config.agent.claimText) || '🔍 去聊天框核验') + '</button>' +
        '<button class="ghost" data-contact="' + it.id + '">' + (isFound ? '✉️ 联系拾者' : '✉️ 联系失主') + '</button>' +
        (it.image ? '' : '<button class="ghost" data-addphoto="' + it.id + '">📷 补张照片</button>') +
        '</div>' +
        '</div></div>';
    }).join('');

    paintReturnedCard(false);   // 重绘后把已找回提示卡补回顶部
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

      document.dispatchEvent(new CustomEvent('lf:changed'));   // 广场 + 信箱一起刷新
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
  function waitAndFocus(id, tries, settled) {
    tries = tries || 0;
    if (el('item-' + id)) { jumpTo(id); return; }
    if (tries < 26) {
      setTimeout(function () { waitAndFocus(id, tries + 1, settled); }, 150);
      return;
    }
    // 等够了还是没有：确认下是「记录已下架」还是「编号压根不存在」
    if (settled) explainMissing(id);
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
    // 先查状态：已找回的记录不在广场列表里，输入编号也能看到它的归宿（无需登录）
    var listed = all.filter(function (x) { return x.id === id; })[0];
    if (!listed) {
      var probe = await LF.api.findItemById(id);
      if (!probe) {
        LF.ui.toast('没有找到 LF-' + id + ' 这条记录，编号可能不对', 'error', 4000);
        return false;
      }
      if (probe.status === 'returned') {
        showReturnedCard(id, probe);
        return true;
      }
    }
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
    ['bind-code'].forEach(function (k) {
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
    waitAndFocus(id, 0, true);
  }

  /**
   * 深链容错：阿寻给的 #item-<id> 可能指向一条已经 returned 的记录。
   * listPublicItems() 会把 returned 过滤掉，卡片根本不存在 —— 老逻辑会白跳，
   * 用户只看到广场顶部，以为链接坏了。这里区分「还没加载完」和「确实不在」：
   * 加载完仍找不到，就查明原因并给一条明确提示。
   */
  async function explainMissing(id) {
    var item = null;
    try { item = await LF.api.findItemById(id); } catch (e) { /* 忽略，走通用提示 */ }
    if (!item) {
      LF.ui.toast('没有找到 LF-' + id + ' 这条记录，编号可能不对', 'error', 4500);
      return;
    }
    var label = 'LF-' + id + (item.title ? '「' + item.title + '」' : '');
    if (item.status === 'returned') {
      showReturnedCard(id, item);
    } else if (item.status === 'claimed') {
      LF.ui.toast(label + ' 已有人认领，广场上还留着记录，往下翻翻看', 'info', 5000);
    } else {
      LF.ui.toast('广场里暂时没有 ' + label + '，点「🔄 刷新广场」再试一次', 'info', 4500);
    }
  }

  /**
   * 已找回记录的常驻提示卡。
   *
   * 为什么不用 toast：拾得人登记→绑定→物品被认领找回，全程在网页上只有
   * 这一个「确认归宿」的时机，5 秒 toast 一闪而过等于没确认。改成卡片插在
   * 广场顶部，明确告诉他这条已成功找回、何时认领，直到下次刷新广场才消失。
   * 只展示公开字段（标题 / 认领时间 / 公开说明），detail 与 location 不出现。
   */
  function buildReturnedCard(id, item) {
    var claimAt = item.claimAt ? new Date(item.claimAt) : null;
    var claimText = claimAt && !isNaN(claimAt.getTime())
      ? '认领完成于 ' + claimAt.toLocaleString('zh-CN', { hour12: false })
      : '认领已完成';
    var card = document.createElement('div');
    card.className = 'returned-card';
    card.id = 'returned-card';
    card.innerHTML =
      '<div class="returned-card-main">' +
      '<div class="returned-card-icon">✅</div>' +
      '<div class="returned-card-body">' +
      '<b>LF-' + id + (item.title ? '「' + LF.ui.esc(item.title) + '」' : '') + '已被认领，成功找回</b>' +
      '<div class="muted">' + claimText + '。已找回的物品按广场规则从列表下架，记录本身留档。' +
      (item.notice ? '<br>原发布说明：「' + LF.ui.esc(item.notice) + '」' : '') +
      '</div></div>' +
      '<button class="ghost returned-card-close" id="returned-card-close">知道了</button>' +
      '</div>';
    return card;
  }

  /** 把粘住的提示卡渲染到列表顶部（scroll=true 时滚过去，供深链进站使用） */
  function paintReturnedCard(scroll) {
    var box = el('square-list');
    if (!box || !returnedSticky) return;
    var old = el('returned-card');
    if (old) old.remove();
    var card = buildReturnedCard(returnedSticky.id, returnedSticky.item);
    box.insertBefore(card, box.firstChild);
    if (scroll) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function showReturnedCard(id, item) {
    returnedSticky = { id: id, item: item };
    paintReturnedCard(true);
  }

  /* 首屏骨架屏：比「正在加载广场…」一行字更像真页面，减少白屏感 */
  function skeletonHTML() {
    var one = '<div class="sk-item">' +
      '<div class="sk-thumb"></div>' +
      '<div class="sk-body"><div class="sk-line w60"></div><div class="sk-line w30"></div>' +
      '<div class="sk-line w90"></div></div></div>';
    return '<div class="skeleton">' + one + one + one + '</div>';
  }

  LF.square.render = async function (opts) {
    opts = opts || {};
    var box = el('square-list');
    if (box && !opts.silent) box.innerHTML = skeletonHTML();

    // 轮询刷新时的滚动位置：不能把用户正在看的卡片刷回顶部
    var scrollY = opts.silent ? window.scrollY : 0;

    var items = await LF.api.listPublicItems();
    // 只取最新 60 条，避免图片太多拖慢首屏
    all = items.slice(0, 60);

    if (opts.silent && sameData(items.slice(0, 60))) {
      return;   // 数据没变就不重绘，省一次 DOM 抖动
    }
    draw();
    if (opts.silent) window.scrollTo(0, scrollY);
  };

  /** 判断拉回来的列表和当前渲染的是否一致（只比 id + status，够用且便宜） */
  var lastSig = '';
  function sameData(rows) {
    var sig = rows.map(function (x) { return x.id + ':' + x.status + ':' + (x.image ? 1 : 0); }).join('|');
    if (sig === lastSig) return true;
    lastSig = sig;
    return false;
  }

  /* ================================================================
   * 自动刷新
   *
   * 阿寻在另一个进程里写库，网页这边感知不到。原来只有「切页签 / 点刷新」
   * 两个时机，用户聊天框登记完切过来看不到，会以为登记失败、重复登记。
   * 这里每 20 秒静默拉一次（页面隐藏时跳过），跟 notify.js 的轮询节奏一致。
   * ================================================================ */
  var POLL_MS = 20000;
  var pollTimer = null;

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (document.hidden) return;                              // 后台标签页不拉，省流量
      var panel = el('panel-square');
      if (!panel || !panel.classList.contains('active')) return; // 只在广场页签可见时跑
      LF.square.render({ silent: true });
    }, POLL_MS);
  }


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

    // 页面已经开着时再点 #item-<id> 链接，只会改 hash、不会重载——必须监听 hashchange
    window.addEventListener('hashchange', function () { focusFromHash(); });

    // 「知道了」关掉已找回提示卡
    document.addEventListener('click', function (e) {
      if (!e.target.closest || !e.target.closest('#returned-card-close')) return;
      returnedSticky = null;
      var c = el('returned-card');
      if (c) c.remove();
    });

    // 补照片：登录后才能补，避免有人随手改别人的记录（广场 + 我的发布共用 addPhotoById）
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-addphoto]');
      if (!btn) return;
      LF.square.addPhotoById(Number(btn.getAttribute('data-addphoto')));
    });

    // 编号绑定：阿寻给的 LF-xx 在这里换回归属（发布面板已下线，只剩广场顶部这一个入口）
    [['bind-code', 'btn-bind-code']].forEach(function (pair) {
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

    /* 「去聊天框核验」：认领核验已搬到人设文件，网页不再出题判答。
       点一下说明去哪里核验，并把编号提示出来，方便用户直接对阿寻说。 */
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-claim]');
      if (!btn) return;
      var id = Number(btn.getAttribute('data-claim'));
      var item = all.filter(function (x) { return x.id === id; })[0];
      var code = 'LF-' + id;
      LF.ui.toast('认领核验在聊天框里做：跟「寻物官 · 阿寻」说「我要认领 ' + code + '」', 'info', 6000);
      if (item) waitAndFocus(id, 0, false);
    });

    // 切回标签页时补拉一次（用户可能在聊天框登记完就切回来）
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      var panel = el('panel-square');
      if (panel && panel.classList.contains('active')) LF.square.render({ silent: true });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    bind();
    startPolling();
    // 首页就预热一次，切过去不空
    LF.square.render().then(function () {
      setTimeout(focusFromHash, 200);   // 等首屏渲染完再处理 #item-<id> 直达
    });
  });
})();
