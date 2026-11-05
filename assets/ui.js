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

  /* ================= 列表渲染 ================= */
  LF.ui.renderMyPosts = function (items, opts) {
    opts = opts || {};
    var box = document.getElementById('my-posts');
    if (!box) return;
    if (!items.length) { box.innerHTML = '<div class="empty">还没有发布记录</div>'; return; }
    box.innerHTML = items.map(function (it) {
      var delBtn = opts.canDelete
        ? '<button class="btn-del" data-del="' + it.id + '">删除</button>'
        : '';
      var msgBtn = '<button class="ghost btn-msg" data-thread="' + it.id + '">💬 留言<span class="badge hidden" data-msgcount="' + it.id + '"></span></button>';
      var statusText = { open: '待认领', claimed: '有人认领', returned: '已找回' }[it.status || 'open'] || it.status;
      return '' +
        '<div class="item">' +
        (it.image ? '<img class="thumb" src="' + it.image + '" alt="">' : '<div class="thumb"></div>') +
        '<div class="item-body">' +
        '<div class="item-title">' + LF.ui.esc(it.title) +
        ' <span class="badge">已隐藏细节</span>' +
        ' <span class="badge' + (it.status === 'returned' ? '' : ' score') + '">' + LF.ui.esc(statusText) + '</span>' +
        '</div>' +
        '<div class="item-meta">' + LF.ui.esc(it.time || '') + '</div>' +
        '<div class="item-desc">🔒 细节与位置仅匹配确认后展示</div>' +
        (it.aiDesc ? '<div class="item-desc ai">🤖 ' + LF.ui.esc(it.aiDesc) + '</div>' : '') +
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
        (it.image ? '<img class="thumb" src="' + it.image + '" alt="">' : '<div class="thumb"></div>') +
        '<div class="item-body">' +
        '<div class="item-title">' + LF.ui.esc(it.title) +
        ' <span class="badge' + labelCls + '">' + LF.ui.esc(label) + '</span>' +
        '</div>' +
        '<div class="item-meta">' + LF.ui.esc(meta.methodText || '') + ' · ' + LF.ui.esc(it.time || '') + '</div>' +
        (it.aiDesc ? '<div class="item-desc">🤖 ' + LF.ui.esc(it.aiDesc) + '</div>' : '') +
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
})();
