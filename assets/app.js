/**
 * assets/app.js —— 流程编排（B 拥有，A 已放可运行基线）
 * 这里只做「串流程」，不写具体算法与 AI 提示词：
 *   数据 → LF.api.*      检索 → LF.search.* / LF.match.*      AI → LF.ai.*
 *
 * TODO（B）：
 *   1. 打开页面先选模式（我丢了东西 / 我来找东西），再进各自流程；✅ showEntryMask
 *   2. 录入改成分步气泡式对话（名称 → 照片 → 地点 → 隐藏细节）；✅ buildWizard / renderWizard
 *   3. 位置按钮：navigator.geolocation 取坐标 → 文字提示（坐标不落库，合规）。✅ locate
 *   4. 粘贴 / 拖拽上传（发布页 + 检索页 + 分步录入）。✅ bindPaste / makeDropZone
 */
(function () {
  'use strict';

  var state = {
    image: null,          // 发布用压缩图
    colorFeature: null,   // 发布用颜色特征
    searchImage: null,    // 检索用压缩图（粘贴 / 拖拽 / 选择文件都存这里）
    postType: 'lost',     // lost=失者发布 / found=拾者发布
    item: null,           // 当前认领中的物品
    question: '',         // AI 生成的问题
    attempts: 0
  };

  function el(id) { return document.getElementById(id); }

  /* ================= 发布 ================= */
  async function onPickPublishImage(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { LF.ui.toast('请选择图片文件', 'error'); return; }
    var raw = await LF.ui.fileToDataURL(file);
    state.image = await LF.ui.compressImage(raw);
    state.colorFeature = await LF.ui.extractColorFeature(state.image);
    var box = el('pub-preview');
    if (box) box.innerHTML = '<img class="preview" src="' + state.image + '" alt="预览">';
  }

  /* ================================================================
   * B1 · 双入口选择（打开页面先选身份）
   * 「我丢了东西」→ 发布面板 + post-type 切到 lost
   * 「我捡到了东西」→ 广场 panel-square
   * 选择记入 sessionStorage，刷新不重复弹出；顶部 tabs 仍是切换入口
   * ================================================================ */
  var ENTRY_KEY = 'lf_entry_choice';

  function dismissEntryMask(mask) {
    if (!mask || !mask.parentNode) return;
    mask.classList.add('hide');
    setTimeout(function () { if (mask.parentNode) mask.remove(); }, 350);
  }

  function showEntryMask() {
    var chosen = null;
    try { chosen = sessionStorage.getItem(ENTRY_KEY); } catch (e) { /* 忽略 */ }
    if (chosen) return;

    var mask = document.createElement('div');
    mask.className = 'entry-mask';
    mask.innerHTML = '' +
      '<div class="entry-title">欢迎使用失物招领 🧭</div>' +
      '<div class="entry-sub">先选一个身份，之后随时可以在顶部标签里切换</div>' +
      '<div class="entry-cards">' +
      '<div class="entry-card" data-entry="lost">' +
      '<div class="entry-emoji">😢</div><b>我丢了东西</b><span>发布失物信息，等大家帮你找</span></div>' +
      '<div class="entry-card" data-entry="found">' +
      '<div class="entry-emoji">🙋</div><b>我捡到了东西</b><span>去广场看看有没有人正在找</span></div>' +
      '</div>' +
      '<button type="button" class="entry-skip">先随便看看 →</button>';
    document.body.appendChild(mask);

    mask.querySelector('[data-entry="lost"]').addEventListener('click', function () {
      try { sessionStorage.setItem(ENTRY_KEY, 'lost'); } catch (e) { /* 忽略 */ }
      var pt = document.querySelector('.post-type[data-type="lost"]');
      if (pt) pt.click();                       // 与 A 的 postType 状态联动
      var tab = document.querySelector('.tab[data-tab="publish"]');
      if (tab) tab.click();                     // 复用现成 tab 逻辑
      dismissEntryMask(mask);
      LF.ui.toast('已进入发布面板，跟着 🤖 提示一步步填就行', 'info', 2600);
    });

    mask.querySelector('[data-entry="found"]').addEventListener('click', function () {
      try { sessionStorage.setItem(ENTRY_KEY, 'found'); } catch (e) { /* 忽略 */ }
      var tab = document.querySelector('.tab[data-tab="square"]');
      if (tab) tab.click();
      dismissEntryMask(mask);
      LF.ui.toast('这是广场 · 大家捡到的东西都在这里，也可以切「🔍 找东西」做 AI 检索', 'info', 3000);
    });

    mask.querySelector('.entry-skip').addEventListener('click', function () {
      dismissEntryMask(mask);
    });
  }

  /* ================================================================
   * B2 · 粘贴 + 拖拽上传
   * 任何图片都必须先 compressImage（480 / JPEG 0.75），原图绝不入库
   * ================================================================ */

  // 当前图片应流向哪个目标：分步录入进行中 > 当前激活面板
  function currentImageTarget() {
    if (wiz.onImageStep) return 'wizard';
    var panel = document.querySelector('.panel.active');
    if (!panel) return null;
    if (panel.id === 'panel-publish') return 'publish';
    if (panel.id === 'panel-search') return 'search';
    return null;
  }

  function handleImageFileFor(target, file, okMsg) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { LF.ui.toast('请拖入 / 粘贴图片文件（jpg / png / webp）', 'error'); return; }
    if (target === 'publish') {
      onPickPublishImage(file);
      if (okMsg) LF.ui.toast(okMsg, 'success', 1600);
    } else if (target === 'search') {
      setSearchImage(file, okMsg);
    } else if (target === 'wizard') {
      setWizardImage(file, okMsg);
    }
  }

  async function setSearchImage(file, okMsg) {
    var raw = await LF.ui.fileToDataURL(file);
    state.searchImage = await LF.ui.compressImage(raw);   // 先压缩，原图不留
    showSearchPreview();
    if (okMsg) LF.ui.toast(okMsg, 'success', 1600);
  }

  function showSearchPreview() {
    var box = el('search-preview');
    if (!box) return;
    box.innerHTML = state.searchImage
      ? '<img class="preview" src="' + state.searchImage + '" alt="检索用图预览">'
      : '';
  }

  function bindPaste() {
    document.addEventListener('paste', function (e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image') === 0) {
          var f = items[i].getAsFile();
          var target = currentImageTarget();
          if (!f || !target) return;          // 不在发布/检索/录入场景，不打扰
          e.preventDefault();
          handleImageFileFor(target, f, '已粘贴图片');
          return;
        }
      }
    });
  }

  /** 在输入框下面动态插一个拖拽区（不修改 index.html） */
  function makeDropZone(afterEl, target, text) {
    if (!afterEl || afterEl._dropZoneBound) return;
    afterEl._dropZoneBound = true;
    var zone = document.createElement('div');
    zone.className = 'drop-zone';
    zone.innerHTML = '<span class="dz-icon">🖼️</span><span class="dz-text">' + text + '</span>';
    afterEl.parentNode.insertBefore(zone, afterEl.nextSibling);
    LF.ui.enableDropZone(zone, function (f) { handleImageFileFor(target, f, '已载入图片'); });
    zone.addEventListener('click', function () {
      var inp = target === 'search' ? el('search-image') : el('pub-image');
      if (inp) inp.click();
    });
  }

  function addSearchPreviewBox() {
    var input = el('search-image');
    if (!input || el('search-preview')) return;
    var box = document.createElement('div');
    box.id = 'search-preview';
    input.parentNode.insertBefore(box, input.nextSibling);
  }

  /* ================================================================
   * B3 · 分步气泡录入（名字 → 照片 → 位置 → 隐藏细节 → 确认发布）
   * 用步骤数组驱动；draft 最后一次性 createItem，不逐步写库
   * ================================================================ */
  var wiz = { draft: {}, idx: 0, onImageStep: false };

  function wizardSteps() {
    var isLost = state.postType !== 'found';
    return [
      { key: 'postType', type: 'identity',
        ask: '先确认一下：你是丢了东西，还是捡到了东西？' },
      { key: 'title', type: 'text', required: true,
        ask: isLost ? '丢的是什么？（物品名称）' : '捡到了什么？（物品名称）',
        placeholder: isLost ? '例：黑色雨伞' : '例：蓝色书包' },
      { key: 'image', type: 'image', required: false, skippable: true,
        ask: '有照片吗？可以直接 Ctrl/Cmd+V 粘贴，或拖拽、点击选择文件' },
      { key: 'location', type: 'location', required: false,
        ask: isLost ? '大概在哪里丢的？' : '大概在哪里捡到的？',
        placeholder: '例：图书馆三楼东侧靠窗座位' },
      { key: 'detail', type: 'textarea', required: true,
        ask: '有没有别人不知道的细节？（🔒 仅用于核实身份，不会公开）',
        hint: isLost
          ? '比如贴纸、划痕、里面装了什么——只有真失主答得上来，AI 核实全靠它'
          : '比如物品里装的东西、磨损位置——只有真失主答得上来，AI 核实全靠它' }
    ];
  }

  function chooseIdentity(type) {
    wiz.draft.postType = type;
    var btn = document.querySelector('.post-type[data-type="' + type + '"]');
    if (btn) btn.click();   // 与 A 的 postType 状态 / 文案联动
    wiz.idx++;
    renderWizard();
  }

  async function setWizardImage(file, okMsg) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { LF.ui.toast('请拖入 / 粘贴图片文件（jpg / png / webp）', 'error'); return; }
    var raw = await LF.ui.fileToDataURL(file);
    wiz.draft.image = await LF.ui.compressImage(raw);              // 必须压缩
    wiz.draft.colorFeature = await LF.ui.extractColorFeature(wiz.draft.image);
    if (okMsg) LF.ui.toast(okMsg, 'success', 1600);
    renderWizard();
  }

  function wizAnswerText(step) {
    var v = wiz.draft[step.key];
    if (step.key === 'image') return v ? '[图片已添加]' : '(跳过)';
    if (step.key === 'postType') return v === 'found' ? '我捡到了东西' : '我丢了东西';
    return v ? String(v) : '(跳过)';
  }

  function buildWizard() {
    var panel = el('panel-publish');
    var formCard = panel ? panel.querySelector('.card') : null;
    if (!panel || !formCard || el('wiz-card')) return;

    var card = document.createElement('div');
    card.className = 'card wiz-card';
    card.id = 'wiz-card';
    card.innerHTML = '' +
      '<div class="wiz-head"><b>🤖 对话式发布</b>' +
      '<button type="button" class="ghost wiz-toggle-form" id="wiz-toggle">🧾 切换传统表单</button></div>' +
      '<div class="wiz-chat" id="wiz-chat"></div>' +
      '<div id="wiz-input"></div>';
    panel.insertBefore(card, formCard);

    // 传统表单保留但默认收起，随时可切回（A 的 post-type / 事件都还在 DOM 里）
    formCard.classList.add('form-hidden');
    el('wiz-toggle').addEventListener('click', function () {
      wiz.onImageStep = false;                       // 切走时让出粘贴目标
      var hiding = formCard.classList.toggle('form-hidden');
      this.textContent = hiding ? '🧾 切换传统表单' : '🤖 返回对话式发布';
    });

    renderWizard();
  }

  function wizOpsBar(opsHtml) {
    return '<div class="wiz-ops">' + opsHtml + '</div>';
  }

  function renderWizard() {
    var chat = el('wiz-chat'), inputBox = el('wiz-input');
    if (!chat || !inputBox) return;
    var steps = wizardSteps();
    wiz.onImageStep = false;

    // 已回答步骤的历史气泡
    var html = '';
    for (var i = 0; i < steps.length && i < wiz.idx; i++) {
      html += '<div class="wiz-bubble ai">' + LF.ui.esc(steps[i].ask) + '</div>' +
              '<div class="wiz-bubble user">' + LF.ui.esc(wizAnswerText(steps[i])) + '</div>';
    }
    chat.innerHTML = html;

    // 全部答完 → 确认页
    if (wiz.idx >= steps.length) { renderWizardConfirm(chat, inputBox); return; }

    var step = steps[wiz.idx];
    var ai = document.createElement('div');
    ai.className = 'wiz-bubble ai';
    ai.textContent = step.ask;
    chat.appendChild(ai);

    inputBox.innerHTML = '';
    var backBtn = wiz.idx > 0
      ? '<button type="button" class="ghost" data-wiz="back">← 上一步</button>' : '';

    if (step.type === 'identity') {
      inputBox.innerHTML = wizOpsBar(
        '<button type="button" id="wiz-identity-lost">😢 我丢了东西</button>' +
        '<button type="button" class="ghost" id="wiz-identity-found">🙋 我捡到了东西</button>');
      el('wiz-identity-lost').addEventListener('click', function () { chooseIdentity('lost'); });
      el('wiz-identity-found').addEventListener('click', function () { chooseIdentity('found'); });

    } else if (step.type === 'text' || step.type === 'textarea') {
      var wrap = document.createElement('div');
      wrap.className = 'wiz-input-row';
      var inp = document.createElement(step.type === 'textarea' ? 'textarea' : 'input');
      if (step.type !== 'textarea') inp.type = 'text';
      inp.id = 'wiz-field';
      inp.value = wiz.draft[step.key] || '';
      inp.placeholder = step.placeholder || (step.type === 'textarea' ? '写具体一点，AI 核实全靠它' : '输入后点下一步');
      inp.setAttribute('enterkeyhint', 'next');
      wrap.appendChild(inp);
      inputBox.appendChild(wrap);

      inputBox.insertAdjacentHTML('beforeend', wizOpsBar(
        backBtn +
        (step.skippable ? '<button type="button" class="ghost wiz-skip" data-wiz="skip">跳过</button>' : '') +
        '<button type="button" data-wiz="next">' + (step.required ? '下一步 →' : '下一步（可留空）→') + '</button>'));
      if (step.hint) {
        inputBox.insertAdjacentHTML('beforeend', '<div class="hint">' + LF.ui.esc(step.hint) + '</div>');
      }

      var nextBtn = inputBox.querySelector('[data-wiz="next"]');
      nextBtn.addEventListener('click', function () {
        var v = el('wiz-field').value.trim();
        if (step.required && !v) { LF.ui.toast('这一项需要填写哦', 'error'); el('wiz-field').focus(); return; }
        wiz.draft[step.key] = v;
        wiz.idx++;
        renderWizard();
      });
      var skipBtn = inputBox.querySelector('[data-wiz="skip"]');
      if (skipBtn) skipBtn.addEventListener('click', function () {
        wiz.draft[step.key] = ''; wiz.idx++; renderWizard();
      });
      var backB = inputBox.querySelector('[data-wiz="back"]');
      if (backB) backB.addEventListener('click', function () { wiz.idx--; renderWizard(); });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && step.type === 'text') { e.preventDefault(); nextBtn.click(); }
      });
      setTimeout(function () { inp.focus(); }, 0);

    } else if (step.type === 'image') {
      wiz.onImageStep = true;
      inputBox.innerHTML = '' +
        '<div class="drop-zone wiz-drop"><span class="dz-icon">📷</span><span class="dz-text">把图片拖到这里，或直接 Ctrl/Cmd+V 粘贴，点这里选择文件</span></div>' +
        '<div class="wiz-img-prev" id="wiz-img-prev"></div>' +
        wizOpsBar(backBtn +
          '<button type="button" class="ghost" data-wiz="skip">' + (wiz.draft.image ? '删除照片并继续 →' : '没有照片，跳过 →') + '</button>' +
          '<button type="button" data-wiz="next">下一步 →</button>');

      var zone = inputBox.querySelector('.wiz-drop');
      var fileInp = document.createElement('input');
      fileInp.type = 'file';
      fileInp.accept = 'image/*';
      fileInp.hidden = true;
      inputBox.appendChild(fileInp);
      LF.ui.enableDropZone(zone, function (f) { setWizardImage(f, '已载入图片'); });
      zone.addEventListener('click', function () { fileInp.click(); });
      fileInp.addEventListener('change', function () {
        if (fileInp.files && fileInp.files[0]) setWizardImage(fileInp.files[0], '已载入图片');
      });

      var prevBox = el('wiz-img-prev');
      if (prevBox && wiz.draft.image) {
        prevBox.innerHTML = '<img src="' + wiz.draft.image + '" alt="照片预览">';
      }

      inputBox.querySelector('[data-wiz="next"]').addEventListener('click', function () { wiz.idx++; renderWizard(); });
      inputBox.querySelector('[data-wiz="skip"]').addEventListener('click', function () {
        wiz.draft.image = null; wiz.draft.colorFeature = null; wiz.idx++; renderWizard();
      });
      var backB2 = inputBox.querySelector('[data-wiz="back"]');
      if (backB2) backB2.addEventListener('click', function () { wiz.idx--; renderWizard(); });

    } else if (step.type === 'location') {
      inputBox.innerHTML = '' +
        '<div class="wiz-input-row"><input type="text" id="wiz-field" enterkeyhint="next" placeholder="' +
        (step.placeholder || '') + '"></div>' +
        '<div class="loc-row">' +
        '<button type="button" class="ghost" id="wiz-locate">📍 用当前位置</button>' +
        '<span class="hint">坐标只在本机提示，不会上传</span></div>' +
        '<div id="wiz-loc-hint"></div>' +
        wizOpsBar(backBtn + '<button type="button" data-wiz="next">下一步（可留空）→</button>');

      var locInput = el('wiz-field');
      locInput.value = wiz.draft[step.key] || '';
      el('wiz-locate').addEventListener('click', function () {
        locate(function (lat, lng) { showLocateHint(el('wiz-loc-hint'), lat, lng, 'wiz-field'); });
      });
      inputBox.querySelector('[data-wiz="next"]').addEventListener('click', function () {
        wiz.draft[step.key] = locInput.value.trim();
        wiz.idx++;
        renderWizard();
      });
      var backB3 = inputBox.querySelector('[data-wiz="back"]');
      if (backB3) backB3.addEventListener('click', function () {
        wiz.draft[step.key] = locInput.value.trim();   // 回退也保留当前输入
        wiz.idx--; renderWizard();
      });
      locInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); inputBox.querySelector('[data-wiz="next"]').click(); }
      });
      setTimeout(function () { locInput.focus(); }, 0);
    }

    chat.scrollTop = chat.scrollHeight;
  }

  function renderWizardConfirm(chat, inputBox) {
    var ai = document.createElement('div');
    ai.className = 'wiz-bubble ai';
    ai.textContent = '好的，确认一下信息，没问题就发布：';
    chat.appendChild(ai);

    var d = wiz.draft, isLost = state.postType !== 'found';
    inputBox.innerHTML = '' +
      '<div class="wiz-confirm">' +
      '<div><b>类型：</b>' + (isLost ? '😢 失者发布' : '🙋 拾者发布') + '</div>' +
      '<div><b>名称：</b>' + LF.ui.esc(d.title || '（未填）') + '</div>' +
      '<div><b>照片：</b>' + (d.image ? '有（已压缩到 480px）' : '无') + '</div>' +
      '<div><b>' + (isLost ? '丢失位置' : '拾获位置') + '：</b>' + LF.ui.esc(d.location || '（未填）') + '</div>' +
      '<div><b>🔒 隐藏细节：</b>' + LF.ui.esc(d.detail || '（未填）') + '</div>' +
      '</div>' +
      wizOpsBar(
        '<button type="button" class="ghost" data-wiz="back">← 上一步</button>' +
        '<button type="button" id="wiz-publish">🚀 确认发布</button>');

    inputBox.querySelector('[data-wiz="back"]').addEventListener('click', function () {
      wiz.idx--; renderWizard();
    });
    el('wiz-publish').addEventListener('click', function () { publishFromDraft(this); });
    chat.scrollTop = chat.scrollHeight;
  }

  async function publishFromDraft(btn) {
    var d = wiz.draft;
    if (!d.title || !d.detail) {
      LF.ui.toast('名称和隐藏细节是必填的，返回补一下再发布', 'error');
      return;
    }
    btn.disabled = true;
    btn.textContent = '发布中…' + (d.image ? '（AI 识别图片，约需几秒）' : '');

    var aiDesc = '', aiTags = [];
    if (d.image) {
      var r = await LF.ai.describeImage(d.image);
      if (r.ok) { aiDesc = r.desc; aiTags = r.tags; }
    }

    var res = await LF.api.createItem({
      title: d.title,
      detail: d.detail,
      location: d.location || '',
      image: d.image || null,
      colorFeature: d.colorFeature || null,
      aiDesc: aiDesc,
      aiTags: aiTags,
      status: 'open',
      postType: state.postType,
      ownerId: LF.api.ownerId(),
      time: new Date().toLocaleString('zh-CN')
    });

    btn.disabled = false;
    btn.textContent = '🚀 确认发布';

    if (!res.ok) { LF.ui.toast('云端保存失败：' + res.error, 'error', 3500); return; }

    LF.ui.toast('✅ 发布成功，已同步到云端', 'success');
    wiz.draft = {};          // 清空 draft
    wiz.idx = 0;
    renderWizard();          // 清预览、回到第一步
    renderMyPosts();         // 刷新「我的发布」
  }

  /* ================================================================
   * B4 · 定位填写（合规：坐标不落库、可手填、不接地图 SDK）
   * 坐标只在页面上提示一次，绝不写入数据库 / 绝不上传
   * ================================================================ */
  function locate(callback) {
    if (!navigator.geolocation) { LF.ui.toast('当前浏览器不支持定位，请手动填写', 'error'); return; }
    LF.ui.toast('正在获取位置…', 'info', 1200);
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        var lat = pos.coords.latitude.toFixed(4);
        var lng = pos.coords.longitude.toFixed(4);
        if (callback) callback(lat, lng);
      },
      function () {
        LF.ui.toast('没关系，定位失败或未授权，手动写个大概位置就行', 'info', 3200);
      },
      { timeout: 8000, maximumAge: 60000, enableHighAccuracy: false }
    );
  }

  function showLocateHint(box, lat, lng, focusId) {
    if (!box) return;
    box.className = 'loc-hint';
    box.textContent = '已定位（' + lat + ', ' + lng + '），请补一句具体地点，例：图书馆三楼东侧靠窗';
    var f = focusId ? el(focusId) : el('pub-location');
    if (f) f.focus();
  }

  /** 给传统表单的 pub-location 也加一个定位按钮（动态插入，不动 index.html） */
  function addClassicLocateButton() {
    var input = el('pub-location');
    if (!input || input._locateBtnAdded) return;
    input._locateBtnAdded = true;
    var row = document.createElement('div');
    row.className = 'loc-row';
    row.innerHTML = '' +
      '<button type="button" class="ghost" id="pub-locate">📍 用当前位置</button>' +
      '<span class="hint">坐标只在本机提示，不会上传</span>';
    input.parentNode.insertBefore(row, input.nextSibling);
    var hintBox = document.createElement('div');
    row.parentNode.insertBefore(hintBox, row.nextSibling);
    el('pub-locate').addEventListener('click', function () {
      locate(function (lat, lng) { showLocateHint(hintBox, lat, lng, 'pub-location'); });
    });
  }

  async function publish() {
    var title = el('pub-title').value.trim();
    var detail = el('pub-detail').value.trim();
    var location = el('pub-location').value.trim();
    if (!title || !detail) { LF.ui.toast('请填写物品名称和隐藏细节', 'error'); return; }

    var btn = el('btn-publish');
    if (btn) { btn.disabled = true; btn.textContent = '发布中…'; }

    var aiDesc = '', aiTags = [];
    if (state.image) {
      LF.ui.toast('AI 正在识别图片特征…', 'info', 1800);
      var r = await LF.ai.describeImage(state.image);
      if (r.ok) { aiDesc = r.desc; aiTags = r.tags; }
    }

    var res = await LF.api.createItem({
      title: title,
      detail: detail,
      location: location,
      image: state.image,
      colorFeature: state.colorFeature,
      aiDesc: aiDesc,
      aiTags: aiTags,
      status: 'open',
      postType: state.postType,
      ownerId: LF.api.ownerId(),
      time: new Date().toLocaleString('zh-CN')
    });

    if (btn) { btn.disabled = false; btn.textContent = '发布失物信息'; }

    if (!res.ok) { LF.ui.toast('云端保存失败：' + res.error, 'error', 3500); return; }

    LF.ui.toast(aiDesc ? '✅ 发布成功，AI 已生成特征描述' : '✅ 发布成功，已同步到云端', 'success');
    state.image = null; state.colorFeature = null;
    ['pub-title', 'pub-detail', 'pub-location'].forEach(function (id) { el(id).value = ''; });
    if (el('pub-image')) el('pub-image').value = '';
    if (el('pub-preview')) el('pub-preview').innerHTML = '';
    renderMyPosts();
  }

  async function renderMyPosts() {
    var items = await LF.api.listMyItems();   // 只显示本机发布的（原来会列出所有人的）
    LF.ui.renderMyPosts(items, { canDelete: true });
    if (LF.contact && LF.contact.refreshBadges) LF.contact.refreshBadges();
  }

  async function refreshAll(btn) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 同步中…'; }
    await renderMyPosts();
    if (btn) { btn.disabled = false; btn.textContent = '🔄 同步云端'; }
    LF.ui.toast('已同步最新数据', 'success', 1500);
  }

  async function deletePost(id) {
    if (!window.confirm('确定删除这条记录吗？')) return;
    var res = await LF.api.deleteItem(id);
    if (!res.ok) { LF.ui.toast('删除失败：' + res.error, 'error', 3000); return; }
    LF.ui.toast('已删除该记录', 'info');
    renderMyPosts();
  }

  /* ================= 检索 ================= */
  async function searchByText() {
    var q = el('search-text').value.trim();
    if (!q) { LF.ui.toast('请输入描述', 'error'); return; }
    var btn = el('btn-search-text');
    if (btn) { btn.disabled = true; btn.textContent = '检索中…'; }

    var items = await LF.api.listPublicItems();
    var ex = await LF.ai.expandQuery(q);           // 失败自动降级为本地同义词
    var rows = LF.search.text(items, q, ex.keywords);
    rows = LF.match.annotate(LF.match.topN(rows, 20));

    if (btn) { btn.disabled = false; btn.textContent = '🔤 语义检索'; }
    LF.ui.renderResults(rows, {
      methodText: ex.ok ? 'AI 语义检索' : '本地语义检索'
    });
    if (!rows.length) LF.ui.toast('没有找到匹配，换个说法试试', 'info');
  }

  async function searchByImage() {
    // 来源优先级：文件输入框 > 粘贴/拖拽存入的 state.searchImage
    var f = el('search-image').files && el('search-image').files[0];
    if (f) state.searchImage = await LF.ui.compressImage(await LF.ui.fileToDataURL(f));
    var dataURL = state.searchImage;
    if (!dataURL) { LF.ui.toast('请先选择、粘贴或拖入一张图片', 'error'); return; }

    var btn = el('btn-search-image');
    if (btn) { btn.disabled = true; btn.textContent = '识别中…'; }

    var feat = await LF.ui.extractColorFeature(dataURL);
    var ai = await LF.ai.describeImage(dataURL);   // 让图片变成可比较的文字
    var items = await LF.api.listPublicItems();
    var rows = LF.search.image(items, feat, ai.desc);
    rows = LF.match.annotate(LF.match.topN(rows, 20));

    if (btn) { btn.disabled = false; btn.textContent = '🖼️ 图像检索'; }
    LF.ui.renderResults(rows, {
      methodText: ai.ok ? 'AI 图像语义检索' : '图像颜色检索'
    });
    if (!rows.length) LF.ui.toast('没有找到相近物品，可换图或改用文字检索', 'info');
  }

  /* ================= AI 匹配确认 ================= */
  async function openConfirm(id) {
    var items = await LF.api.listItems();
    var it = items.filter(function (x) { return x.id === id; })[0];
    if (!it) { LF.ui.toast('该记录已不存在', 'error'); return; }

    state.item = it;
    state.attempts = 0;
    state.question = '';

    LF.ui.openModal();
    LF.ui.chatClear();
    LF.ui.chatMsg('ai', '正在根据物品细节准备核实问题…');
    LF.ui.setBusy('AI 思考中…');

    var q = await LF.ai.makeQuestion(it);
    state.question = q.question;

    LF.ui.chatClear();
    LF.ui.chatMsg('ai', '你好，我来核实一下这件「' + it.title + '」。' + q.question);
    LF.ui.showAnswerInput(LF.config.ai.maxAttempts, submitAnswer);
  }

  async function submitAnswer(text, answerImage) {
    var item = state.item;
    if (!item) return;
    if (text) LF.ui.chatMsg('user', text + (answerImage ? '（附照片）' : ''));
    else if (answerImage) LF.ui.chatMsg('user', '（上传了一张照片）');

    state.attempts++;
    LF.ui.setBusy('AI 正在判断你的回答…');

    var res = await LF.ai.judgeAnswer(item, state.question, text, answerImage);

    if (res.pass) {
      LF.ui.chatMsg('ai', '✅ 特征吻合，匹配确认成功！');
      LF.ui.showMatchSuccess(item);
      if (LF.contact && LF.contact.attachFinderEntry) LF.contact.attachFinderEntry(item);
      LF.ui.toast('🎉 匹配确认成功', 'success');
      // 记录认领状态（C 的认领流会在此扩展状态机）
      LF.api.updateItem(item.id, { status: 'claimed', claimAt: new Date().toISOString() });
      return;
    }

    var remain = LF.config.ai.maxAttempts - state.attempts;
    if (remain <= 0) {
      LF.ui.chatMsg('ai', '❌ ' + (res.reason || '回答与物品细节不符') + '。次数已用完，为保护失主隐私，请联系发布者线下核实。');
      LF.ui.setAction('<button id="match-close">关闭</button>');
      if (LF.contact && LF.contact.attachFinderEntry) LF.contact.attachFinderEntry(item);
      var btn = el('match-close');
      if (btn) btn.addEventListener('click', LF.ui.closeModal);
      return;
    }
    LF.ui.chatMsg('ai', '❌ ' + (res.reason || '描述与细节不符') + '。请再想想它的独有特征（颜色、标记、破损处等）。');
    LF.ui.showAnswerInput(remain, submitAnswer);
  }

  /* ================= 事件绑定 ================= */
  function bind() {
    // 发布类型切换：失者发布 / 拾者发布
    document.querySelectorAll('.post-type').forEach(function (b) {
      b.addEventListener('click', function () {
        state.postType = b.getAttribute('data-type') || 'lost';
        document.querySelectorAll('.post-type').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        var found = state.postType === 'found';
        var locLabel = document.getElementById('pub-location-label');
        var pubBtn = document.getElementById('btn-publish');
        var detailHint = document.getElementById('pub-detail-hint');
        if (locLabel) locLabel.textContent = (found ? '拾获位置' : '大概丢失位置') + '（🔒 匹配确认后显示）';
        if (pubBtn) pubBtn.textContent = found ? '发布拾获信息' : '发布失物信息';
        if (detailHint) detailHint.textContent = found
          ? '细节不会公开展示。AI 会用它出题核实「来认领的人是不是真正的失主」。'
          : '细节不会公开展示。AI 会用它出题核实「来认领的人是不是真的捡到了它」。';
      });
    });

    var pubImage = el('pub-image');
    if (pubImage) pubImage.addEventListener('change', function (e) { onPickPublishImage(e.target.files[0]); });

    var btnPublish = el('btn-publish');
    if (btnPublish) btnPublish.addEventListener('click', publish);

    var btnRefresh = el('btn-refresh');
    if (btnRefresh) btnRefresh.addEventListener('click', function () { refreshAll(btnRefresh); });

    var btnText = el('btn-search-text');
    if (btnText) btnText.addEventListener('click', searchByText);

    var btnImage = el('btn-search-image');
    if (btnImage) btnImage.addEventListener('click', searchByImage);

    var searchText = el('search-text');
    if (searchText) searchText.addEventListener('keydown', function (e) { if (e.key === 'Enter') searchByText(); });

    // 检索页：文件选择后立即压缩 + 预览（与粘贴/拖拽共用 state.searchImage）
    var searchImage = el('search-image');
    if (searchImage) searchImage.addEventListener('change', async function () {
      var f = this.files && this.files[0];
      if (!f) return;
      state.searchImage = await LF.ui.compressImage(await LF.ui.fileToDataURL(f));
      showSearchPreview();
    });

    // 全局粘贴上传（发布页 / 检索页 / 分步录入的照片步骤）
    bindPaste();

    // 列表里的删除 / 认领按钮（事件委托，B 改渲染结构也不影响）
    document.addEventListener('click', function (e) {
      var del = e.target.closest('[data-del]');
      if (del) { deletePost(Number(del.getAttribute('data-del'))); return; }
      var claim = e.target.closest('[data-claim]');
      if (claim) { openConfirm(Number(claim.getAttribute('data-claim'))); return; }
    });

    // 弹窗遮罩 / 关闭按钮 / Esc 关闭
    var modal = el('modal');
    if (modal) modal.addEventListener('click', function (e) { if (e.target === modal) LF.ui.closeModal(); });
    var modalClose = el('btn-modal-close');
    if (modalClose) modalClose.addEventListener('click', LF.ui.closeModal);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && el('modal').classList.contains('show')) LF.ui.closeModal();
    });

    // 认领留言闭环在 contact.js 里处理完后会广播，这里统一刷新列表
    document.addEventListener('lf:changed', function () { renderMyPosts(); });

    // 登录 / 退出后，“我的发布”跟着账号切换
    document.addEventListener('lf:auth', function () { renderMyPosts(); });

    // Tab 切换
    document.querySelectorAll('.tab').forEach(function (t) {      t.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
        document.querySelectorAll('.panel').forEach(function (x) { x.classList.remove('active'); });
        t.classList.add('active');
        el('panel-' + t.dataset.tab).classList.add('active');
        if (t.dataset.tab === 'publish') renderMyPosts();
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    bind();
    // ---- B 线初始化（全部动态创建 DOM，不改 index.html）----
    makeDropZone(el('pub-image'), 'publish', '把图片拖到这里，或直接 Ctrl/Cmd+V 粘贴（点这里选择文件）');
    makeDropZone(el('search-image'), 'search', '把图片拖到这里，或直接 Ctrl/Cmd+V 粘贴（点这里选择文件）');
    addSearchPreviewBox();
    addClassicLocateButton();
    buildWizard();
    showEntryMask();          // 首次打开先选身份（sessionStorage 记住选择）
    renderMyPosts();
  });
})();
