/**
 * assets/app.js —— 页面编排（2026-11-07 改版：网页降级为只读看板）
 *
 * 改版背景：
 *   所有录入、发布、查找、认领核验都收敛到 WorkBuddy 聊天框里跟「寻物官 · 阿寻」完成；
 *   网页只保留「🏛️ 广场」和「📬 信箱」两个页签，一打开就是广场。
 *
 * 因此本文件从 946 行瘦身到只做四件事：
 *   1. 页签切换（广场 / 信箱）+ 打开页面默认落在广场
 *   2. 首屏广场加载 + 骨架屏 + 深链 #item-<id> 定位容错
 *   3. 聊天框入口横幅（告诉用户登记要去哪、为什么网页没有按钮了）
 *   4. 已删除能力的兜底提示（老链接 / 老按钮点到不再静默失效）
 *
 * 已移出本文件的能力（对应 REFACTOR_PLAN 第 4.2 节）：
 *   发布向导 buildWizard / 双入口遮罩 showEntryMask / 语义检索 / 图像检索 /
 *   AI 出题判答 openConfirm + submitAnswer —— 全部由人设文件接管。
 */
(function () {
  'use strict';

  function el(id) { return document.getElementById(id); }

  function cfg() { return LF.config.agent || {}; }

  /* ================================================================
   * 1 · 页签切换：只有广场和信箱两个
   * 打开页面时 index.html 已把 square 设为 active，这里只维护点击后的状态。
   * ================================================================ */
  function switchTab(name) {
    var tab = document.querySelector('.tab[data-tab="' + name + '"]');
    if (tab) { tab.click(); return; }
    // 面板不存在（例如老链接指向已删除的 publish / search）→ 回广场
    var square = document.querySelector('.tab[data-tab="square"]');
    if (square) square.click();
  }

  function bindTabs() {
    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
        document.querySelectorAll('.panel').forEach(function (x) { x.classList.remove('active'); });
        t.classList.add('active');
        var panel = el('panel-' + t.dataset.tab);
        if (panel) panel.classList.add('active');
        if (t.dataset.tab === 'mailbox' && LF.mailbox && LF.mailbox.render) LF.mailbox.render();
      });
    });

    // 页签只有一个时居中显示（样式上不留空位）
    var wrap = document.querySelector('.tabs');
    if (wrap && wrap.children.length < 3) wrap.classList.add('tabs-compact');
  }

  /* ================================================================
   * 2 · 广场首屏
   * loading 态由 square.js 渲染骨架屏；这里只负责触发和失败兜底。
   * ================================================================ */
  async function bootSquare() {
    if (!LF.square || !LF.square.render) return;
    try {
      await LF.square.render();
    } catch (e) {
      console.error('[app] square boot failed', e);
      var box = el('square-list');
      if (box) {
        box.innerHTML = '<div class="empty">广场加载失败，点「🔄 刷新广场」重试<br>' +
          '<span class="hint">如果一直失败，可能是网络或云端连接问题</span></div>';
      }
    }
  }

  /* ================================================================
   * 3 · 聊天框入口横幅
   * 网页不再有发布 / 检索 / 核验按钮，用户按老习惯来会以为坏了，
   * 所以首屏顶部固定一条说明，点按钮给出「怎么找到阿寻」的操作路径。
   * ================================================================ */
  var agentTipShown = false;

  /* 横幅文案要跟着功能开关走：文字检索开着时再说「不能搜索」就是错的。
     关着（默认）时与 index.html 里的静态文案一致，不做无谓改写。 */
  function bannerDesc() {
    if (window.LF && LF.textSearch && typeof LF.textSearch.enabled === 'function' && LF.textSearch.enabled()) {
      return '网页可以按关键词试搜（结果来自数据库共享检索函数，分级与顺序不重算）；' +
        '登记、认领核验仍然在聊天框里跟阿寻完成。';
    }
    return '网页现在只做展示：不能发布、不能搜索、不能核验。有新东西找不到，回来问阿寻就行。';
  }

  function bindAgentBanner() {
    var banner = el('agent-banner');
    if (banner && cfg().bannerTitle) {
      var t = banner.querySelector('.agent-banner-title');
      var d = banner.querySelector('.agent-banner-desc');
      if (t) t.textContent = '💬 ' + cfg().bannerTitle;
      if (d) d.textContent = bannerDesc();
    }
    var btn = el('agent-banner-btn');
    if (btn) btn.addEventListener('click', function () {
      if (agentTipShown) { LF.ui.toast('照着上面的三步做就行', 'info', 2000); return; }
      agentTipShown = true;
      LF.ui.toast('打开 WorkBuddy → 在左侧「专家」里找「寻物官 · 阿寻」→ 直接说话登记', 'info', 6000);
    });
  }

  /* ================================================================
   * 4 · 已删除能力的兜底
   * 老书签 / 老链接仍可能带 #tab-publish、?tab=search 之类的入口，
   * 直接落到广场并说明原因，避免用户对着一片空白发懵。
   * ================================================================ */
  function handleLegacyEntry() {
    var hash = (location.hash || '').toLowerCase();
    var qs = (location.search || '').toLowerCase();
    var legacy = /publish|search|发布|检索/.test(hash) || /tab=(publish|search)/.test(qs);
    if (!legacy) return;
    LF.ui.toast('发布和查找已经搬到聊天框了：跟「寻物官 · 阿寻」说就行', 'info', 5000);
    if (window.history && history.replaceState) {
      history.replaceState(null, '', location.pathname + location.search.replace(/([?&])tab=(publish|search)&?/i, '$1').replace(/[?&]$/, ''));
    }
  }

  /* ================================================================
   * 5 · 空状态文案：广场没数据时引导去聊天框登记
   * ================================================================ */
  function decorateEmptyState() {
    var box = el('square-list');
    if (!box) return;
    var obs = new MutationObserver(function () {
      var empty = box.querySelector('.empty');
      if (!empty || empty.dataset.decorated) return;
      if (!/还没有/.test(empty.textContent || '')) return;
      empty.dataset.decorated = '1';
      empty.innerHTML = '广场上还没有待认领的物品<br>' +
        '<span class="hint">丢了东西或捡到东西，都在聊天框里跟「寻物官 · 阿寻」说一声，' +
        '登记完这里就能看到。</span>';
    });
    obs.observe(box, { childList: true });
  }

  document.addEventListener('DOMContentLoaded', function () {
    bindTabs();
    bindAgentBanner();
    handleLegacyEntry();
    decorateEmptyState();
    bootSquare();
  });

  // 暴露给其他模块（square 的深链会用到）
  LF.app = {
    switchTab: switchTab,
    bootSquare: bootSquare
  };
})();
