/**
 * assets/app.js —— 流程编排（B 拥有，A 已放可运行基线）
 * 这里只做「串流程」，不写具体算法与 AI 提示词：
 *   数据 → LF.api.*      检索 → LF.search.* / LF.match.*      AI → LF.ai.*
 *
 * TODO（B）：
 *   1. 打开页面先选模式（我丢了东西 / 我来找东西），再进各自流程；
 *   2. 录入改成分步气泡式对话（名称 → 照片 → 地点 → 隐藏细节）；
 *   3. 位置按钮：navigator.geolocation 取坐标 → 转成文字地点（合规要求见 docs/ROADMAP.md）。
 */
(function () {
  'use strict';

  var state = {
    image: null,          // 发布用压缩图
    colorFeature: null,   // 发布用颜色特征
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
    var f = el('search-image').files && el('search-image').files[0];
    if (!f) { LF.ui.toast('请先选择图片', 'error'); return; }
    var btn = el('btn-search-image');
    if (btn) { btn.disabled = true; btn.textContent = '识别中…'; }

    var raw = await LF.ui.fileToDataURL(f);
    var dataURL = await LF.ui.compressImage(raw);
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
    renderMyPosts();
  });
})();
