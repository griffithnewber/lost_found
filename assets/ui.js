/**
 * assets/ui.js —— 视图与交互（B 拥有，A 已放可运行基线，B 直接在此文件上改）
 *
 * 已提供的基础能力（可继续用，也可重写）：
 *   LF.ui.toast(msg, type)                 Toast 提示
 *   LF.ui.esc(str)                         HTML 转义
 *   LF.ui.fileToDataURL(file)              读文件为 dataURL
 *   LF.ui.compressImage(dataURL)           压缩到最长边 480px / JPEG 0.75
 *   LF.ui.extractColorFeature(dataURL)     64 维颜色特征（8x8 降采样）
 *   LF.ui.colorDistance(a, b)              颜色距离
 *   LF.ui.renderMyPosts(items, opts)       发布列表
 *   LF.ui.renderResults(rows, meta)        检索结果
 *   LF.ui.openModal() / closeModal()       确认弹窗
 *   LF.ui.chatClear() / chatMsg(role, text)
 *   LF.ui.setAction(html) / showAnswerInput(remain, onSubmit)
 *   LF.ui.setStatus(text, ok)              右上角连接状态
 *
 * TODO（B 的活）：
 *   1. 粘贴上传：绑定 paste 事件（Ctrl/Cmd+V 直接读剪贴板图片）
 *   2. 拖拽上传：dragover/dragleave/drop + 高亮样式
 *   3. 双入口首页：打开先选「我丢了东西 / 我来找东西」，再进对应面板
 *   4. 对话式分步录入：气泡式追问，可回退上一步、可跳过
 *   5. 位置智能填写：navigator.geolocation → 反解文字 → 可手改（合规见 docs/ROADMAP.md）
 */
(function () {
  'use strict';
  LF.ui = {};

  /* ================= Toast ================= */
  LF.ui.toast = function (msg, type, duration) {
    type = type || 'info';
    duration = duration || 2400;
    var wrap = document.getElementById('toast-wrap');
    if (!wrap) return;
    var el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () {
      el.classList.add('out');
      el.addEventListener('animationend', function () { el.remove(); }, { once: true });
    }, duration);
  };

  LF.ui.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  LF.ui.setStatus = function (text, ok) {
    var el = document.getElementById('cloud-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'sync-flag ' + (ok ? 'cloud-ok' : 'cloud-no');
  };
  LF.api.setStatus = LF.ui.setStatus; // 让数据层用统一的渲染

  /* ================= 图片工具 ================= */
  LF.ui.fileToDataURL = function (file) {
    return new Promise(function (res) {
      var r = new FileReader();
      r.onload = function () { res(r.result); };
      r.readAsDataURL(file);
    });
  };

  LF.ui.compressImage = function (dataURL, maxSide, quality) {
    maxSide = maxSide || 480;
    quality = quality || 0.75;
    return new Promise(function (res) {
      var img = new Image();
      img.onload = function () {
        var w = img.width, h = img.height;
        var scale = Math.min(1, maxSide / Math.max(w, h));
        w = Math.round(w * scale); h = Math.round(h * scale);
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        res(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = function () { res(dataURL); };
      img.src = dataURL;
    });
  };

  LF.ui.extractColorFeature = function (dataURL) {
    return new Promise(function (res) {
      var img = new Image();
      img.onload = function () {
        var s = 8;
        var c = document.createElement('canvas');
        c.width = s; c.height = s;
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, s, s);
        var d = ctx.getImageData(0, 0, s, s).data;
        var feat = [];
        for (var i = 0; i < d.length; i += 4) feat.push(d[i], d[i + 1], d[i + 2]);
        res(feat);
      };
      img.onerror = function () { res(null); };
      img.src = dataURL;
    });
  };

  LF.ui.colorDistance = function (a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    var sum = 0;
    for (var i = 0; i < a.length; i++) sum += Math.pow(a[i] - b[i], 2);
    return Math.sqrt(sum);
  };

  LF.ui.MAX_COLOR_DIST = Math.sqrt(8 * 8 * 3) * 255; // ≈3533.4

  /* ================= 公开信息工具（A 新增 · 防 AI 解读泄露） ================= */

  /** 类别元信息：{ key, label, emoji } */
  LF.ui.categoryMeta = function (key) {
    var list = (LF.config && LF.config.categories) || [];
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return { key: key || '', label: '', emoji: '📦' };
  };

  /** 主色调元信息：{ key, label, hex } */
  LF.ui.toneMeta = function (key) {
    var list = (LF.config && LF.config.colorTones) || [];
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return { key: key || '', label: '', hex: '#b2bec3' };
  };

  /**
   * 生成「重度模糊缩略图」——真正把像素糊掉再上传，不是 CSS 遮罩。
   * 做法：缩到 20px（马赛克化）→ 放大回 320px（双线性）→ 叠加高斯模糊。
   * 拾者发布的照片必须经过这一步：原图绝不上传云端。
   */
  LF.ui.blurImage = function (dataURL, size) {
    size = size || 320;
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var tiny = document.createElement('canvas');
          tiny.width = 20; tiny.height = 20;
          var tctx = tiny.getContext('2d');
          tctx.drawImage(img, 0, 0, 20, 20);

          var out = document.createElement('canvas');
          out.width = size; out.height = size;
          var ctx = out.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          try { ctx.filter = 'blur(10px)'; } catch (e) { /* 老浏览器不支持 filter，马赛克已足够 */ }
          ctx.drawImage(tiny, 0, 0, size, size);
          resolve(out.toDataURL('image/jpeg', 0.6));
        } catch (e) {
          resolve(dataURL);   // 极端情况下退回原图（极罕见）
        }
      };
      img.onerror = function () { resolve(dataURL); };
      img.src = dataURL;
    });
  };

  /**
   * 列表缩略图 HTML（广场 / 我的发布 / 检索结果统一用这个）
   * 拾者发布：有模糊图就显示模糊图 + 类别角标，没有就显示色卡占位；
   * 失者发布：正常显示实物图（公开不构成冒领风险）。
   */
  LF.ui.thumbHTML = function (it) {
    if (it.postType === 'found') {
      var cat = LF.ui.categoryMeta(it.category);
      var tone = LF.ui.toneMeta(it.colorTone);
      // 只有「新流程发布的模糊图」才展示；老数据（无 category）一律用色卡占位，
      // 避免历史原图继续在广场上暴露独特征
      if (it.image && it.category) {
        return '<div class="thumb-wrap">' +
          '<img class="thumb blurred" src="' + it.image + '" alt="">' +
          '<span class="thumb-tag">' + cat.emoji + '</span>' +
          '</div>';
      }
      return '<div class="ph-card" style="background:linear-gradient(135deg,' + tone.hex + '33,' + tone.hex + '99)">' +
        '<span class="ph-emoji">' + cat.emoji + '</span></div>';
    }
    return it.image ? '<img class="thumb" src="' + it.image + '" alt="">' : '<div class="thumb"></div>';
  };

  /** 公开文字：只显示用户自己写的话（notice），绝不显示 AI 描述 */
  LF.ui.noticeHTML = function (it) {
    if (!it.notice) return '';
    return '<div class="item-desc notice">「' + LF.ui.esc(it.notice) + '」</div>';
  };

  /** 拾者发布的泛化标题（类别 + 颜色），失者发布用用户自己填的标题 */
  LF.ui.displayTitle = function (it) {
    if (it.postType === 'found') {
      var cat = LF.ui.categoryMeta(it.category);
      var tone = LF.ui.toneMeta(it.colorTone);
      var parts = [tone.label, cat.label].filter(Boolean).join('·');
      return parts || it.title || '未命名物品';
    }
    return it.title || '未命名物品';
  };

  /* ================= 列表渲染 ================= */
  LF.ui.renderMyPosts = function (items, opts) {
    opts = opts || {};
    var box = document.getElementById('my-posts');
    if (!box) return;
    if (!items.length) {
      box.innerHTML = '<div class="empty">你还没有发布记录<br>' +
        '<span class="hint">想找东西？去「🏛️ 广场」看看别人捡到的</span></div>';
      return;
    }
    box.innerHTML = items.map(function (it) {
      var delBtn = opts.canDelete
        ? '<button class="btn-del" data-del="' + it.id + '">删除</button>'
        : '';
      var msgBtn = '<button class="ghost btn-msg" data-thread="' + it.id + '">💬 留言<span class="badge hidden" data-msgcount="' + it.id + '"></span></button>';
      var statusText = { open: '待认领', claimed: '有人认领', returned: '已找回' }[it.status || 'open'] || it.status;
      var typeText = it.postType === 'found' ? '拾者发布' : '失者发布';
      var returned = it.status === 'returned';
      // 已找回 = 完结归档：隐藏细节徽章失去意义，换成找回日期
      var badges = ' <span class="badge">' + typeText + '</span>';
      if (returned) {
        var d = it.claimAt ? new Date(it.claimAt) : null;
        var when = d && !isNaN(d.getTime())
          ? d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
          : '';
        badges += ' <span class="badge">✅ ' + when + '已找回</span>';
      } else {
        badges += ' <span class="badge">已隐藏细节</span>';
        badges += ' <span class="badge score">' + LF.ui.esc(statusText) + '</span>';
      }
      return '' +
        '<div class="item' + (returned ? ' archived' : '') + '">' +
        LF.ui.thumbHTML(it) +
        '<div class="item-body">' +
        '<div class="item-title">' + LF.ui.esc(LF.ui.displayTitle(it)) + badges + '</div>' +
        '<div class="item-meta">' + LF.ui.esc(it.time || '') + '</div>' +
        LF.ui.noticeHTML(it) +
        (returned
          ? '<div class="item-desc">🎉 物品已顺利找回，已从广场下架</div>'
          : '<div class="item-desc">🔒 细节与位置仅匹配确认后展示</div>') +
        '<div class="item-ops">' + msgBtn + delBtn + '</div>' +
        '</div></div>';
    }).join('');
  };

  LF.ui.renderResults = function (rows, meta) {
    meta = meta || {};
    var box = document.getElementById('search-results');
    if (!box) return;
    if (!rows.length) {
      box.innerHTML = '<div class="empty">没有找到匹配的失物，换个描述试试？</div>';
      return;
    }
    box.innerHTML = rows.map(function (r) {
      var it = r.item || r.it;
      var label = r.label || '';
      var labelCls = r.level === 'high' ? '' : ' score';
      return '' +
        '<div class="item">' +
        LF.ui.thumbHTML(it) +
        '<div class="item-body">' +
        '<div class="item-title">' + LF.ui.esc(LF.ui.displayTitle(it)) +
        ' <span class="badge">' + (it.postType === 'found' ? '拾者发布' : '失者发布') + '</span>' +
        ' <span class="badge' + labelCls + '">' + LF.ui.esc(label) + '</span>' +
        '</div>' +
        '<div class="item-meta">' + LF.ui.esc(meta.methodText || '') + ' · ' + LF.ui.esc(it.time || '') + '</div>' +
        LF.ui.noticeHTML(it) +
        '<div class="item-desc">🔒 位置与细节需确认后显示</div>' +
        '<button class="ghost" style="margin-top:8px" data-claim="' + it.id + '">认领 / 确认匹配</button>' +
        '</div></div>';
    }).join('');
  };

  /* ================= 确认弹窗 ================= */
  LF.ui.openModal = function () {
    document.getElementById('modal').classList.add('show');
  };
  LF.ui.closeModal = function () {
    document.getElementById('modal').classList.remove('show');
    LF.ui.chatClear();
    LF.ui.setAction('');
  };

  LF.ui.chatClear = function () {
    var c = document.getElementById('chat');
    if (c) c.innerHTML = '';
  };

  LF.ui.chatMsg = function (role, text) {
    var c = document.getElementById('chat');
    if (!c) return;
    var div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = text;
    c.appendChild(div);
    c.scrollTop = c.scrollHeight;
  };

  LF.ui.setAction = function (html) {
    var box = document.getElementById('modal-action');
    if (box) box.innerHTML = html || '';
  };

  /**
   * 答案输入区：文本框 + 可选照片 + 剩余次数
   * onSubmit(answerText, answerImageDataURL)
   */
  LF.ui.showAnswerInput = function (remain, onSubmit) {
    var box = document.getElementById('modal-action');
    if (!box) return;
    box.innerHTML = '' +
      '<input type="text" id="answer-input" placeholder="输入你的回答…（剩 ' + remain + ' 次机会）" style="margin-top:10px">' +
      '<div class="answer-tools">' +
      '<label class="file-inline">📷 也可以传张照片<input type="file" id="answer-image" accept="image/*" hidden></label>' +
      '<span id="answer-image-name" class="hint"></span>' +
      '</div>' +
      '<button id="answer-submit">提交回答</button>';

    var input = document.getElementById('answer-input');
    var fileInput = document.getElementById('answer-image');
    var nameEl = document.getElementById('answer-image-name');
    var submitBtn = document.getElementById('answer-submit');
    var answerImage = null;

    fileInput.addEventListener('change', async function () {
      var f = fileInput.files && fileInput.files[0];
      if (!f) return;
      var raw = await LF.ui.fileToDataURL(f);
      answerImage = await LF.ui.compressImage(raw);
      nameEl.textContent = '已选择照片';
    });

    input.focus();
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitBtn.click();
    });
    submitBtn.addEventListener('click', function () {
      var text = input.value.trim();
      if (!text && !answerImage) { LF.ui.toast('请先输入回答', 'error'); return; }
      submitBtn.disabled = true;
      onSubmit(text, answerImage);
    });
  };

  /** 弹窗内的忙碌 / 结果区 */
  LF.ui.setBusy = function (text) {
    LF.ui.setAction('<div class="hint" style="margin-top:10px">' + LF.ui.esc(text) + '</div>');
  };

  LF.ui.showMatchSuccess = function (item) {
    LF.ui.setAction('' +
      '<div class="match-box">' +
      '<div>📍 <b>存放/发现位置：</b>' + LF.ui.esc(item.location || '发布者未填写') + '</div>' +
      '<div style="margin-top:6px">📞 已记录认领，请留意发布者联系。</div>' +
      '<div style="margin-top:6px;color:#888">物品名称：' + LF.ui.esc(item.title) + '</div>' +
      '</div>' +
      '<button id="match-done">完成</button>');
    var btn = document.getElementById('match-done');
    if (btn) btn.addEventListener('click', LF.ui.closeModal);
  };

  /* ================= 拖拽上传区（B 新增） ================= */
  /**
   * 给任意元素套上「拖图片进来即可上传」的能力。
   * zone 内需含 .dz-text 元素作为提示文案（拖入时会临时换成「松手即可上传」）。
   * onFile(file) 只会收到图片文件；非图片会红字提示。
   */
  LF.ui.enableDropZone = function (zone, onFile) {
    var depth = 0;
    var label = zone.querySelector('.dz-text');
    var origin = label ? label.textContent : '';

    function highlight() {
      if (label) label.textContent = '松手即可上传';
      zone.classList.add('dragging');
    }
    function reset() {
      depth = 0;
      if (label) label.textContent = origin;
      zone.classList.remove('dragging');
    }

    ['dragenter', 'dragover'].forEach(function (k) {
      zone.addEventListener(k, function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (k === 'dragenter') { depth++; highlight(); }
        else zone.classList.add('dragging');
      });
    });
    zone.addEventListener('dragleave', function (e) {
      e.preventDefault();
      e.stopPropagation();
      depth--;
      if (depth <= 0) reset();
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      reset();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && /^image\//.test(f.type)) onFile(f);
      else LF.ui.toast('请拖入图片文件（jpg / png / webp）', 'error');
    });
  };
})();
