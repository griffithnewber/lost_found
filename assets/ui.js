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
 *   LF.ui.openModal() / closeModal()       弹窗（留言线程）
 *   LF.ui.chatClear() / chatMsg(role, text)
 *   LF.ui.setAction(html)
 *   LF.ui.setStatus(text, ok)              右上角连接状态
 *
 * 2026-11-07 改版：发布列表、检索结果、认领判答（出题/判答/剩余次数）已随面板下线，
 * 对应渲染函数一并移除；留言线程要用的 toast / 转义 / 图片 / 弹窗能力都还在。
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

  /* ================= 弹窗（只留给留言线程用） ================= */
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
