/**
 * assets/textsearch.js —— 文字检索入口（受开关控制的**最小**实现）
 *
 * 为什么需要它：检索算法已经搬到数据库共享函数 lf_search_text_v1，
 * LF.api.searchItems() 也早就写好了，但页面上一直**没有任何调用方**。
 * 一个没有调用方的接口等于没有验证过 —— 网关、权限、返回列、分级文案
 * 这些问题只有真的点一次才会暴露。
 *
 * 开关（满足任一即开启，默认关）：
 *   1) LF.config.features.textSearch === true
 *   2) 地址栏带 ?textsearch=1
 * 关闭时：卡片保持 hidden、不绑事件，页面文案照旧说「网页不做搜索」。
 * 打开时：只多一个「输入关键词 → 看函数返回结果」的入口；
 *   广场、信箱、留言、聊天核验流程一律不动。
 *
 * 三条硬约束（都有测试：tests/unit/textsearch.test.mjs）：
 *   1. 结果**只**来自 LF.api.searchItems()，前端不做任何本地打分；
 *   2. 顺序 / rank / score / level / label 全部照抄函数返回值，不重排不重算；
 *   3. 失败显示「检索失败」并带原因，**绝不说「没有匹配」**。
 */
(function () {
  'use strict';

  LF.textSearch = {};

  var CARD = 'text-search-card';
  var INPUT = 'text-search-input';
  var BUTTON = 'btn-text-search';
  var HINT = 'text-search-hint';
  var LIST = 'text-search-list';

  function el(id) { return document.getElementById(id); }

  /**
   * 开关状态。
   * 用 ?? 而不是 ||：config 里显式写 false 时不该被 URL 参数悄悄覆盖成 true 吗？
   * —— 不，URL 参数就是「临时打开看看」的手段，优先级高于 config 的默认值；
   *    config 里写 true 则是「这个环境长期开」。
   */
  LF.textSearch.enabled = function () {
    var cfg = (LF.config && LF.config.features) || {};
    var search = (typeof location !== 'undefined' && location.search) || '';
    if (/(?:\?|&)textsearch=1(?:&|$)/.test(search)) return true;
    if (/(?:\?|&)textsearch=0(?:&|$)/.test(search)) return false;
    return cfg.textSearch === true;
  };

  /**
   * 把 searchItems 的返回值翻成「可渲染的状态」——纯函数，单独可测。
   * @returns {{state:'ok'|'empty'|'error', message:string, rows:Array}}
   *   ok    ：有结果（rows 保持函数返回顺序）
   *   empty ：检索**成功**且确实 0 条 —— 只有这种才能说「没有匹配」
   *   error ：任何失败，message 里必须写明原因
   */
  LF.textSearch.describe = function (res) {
    if (!res || res.ok !== true) {
      var why = (res && (res.error || res.code)) || '未知错误';
      return {
        state: 'error',
        message: '检索失败：' + why + '（这是失败，不是没有匹配）',
        rows: []
      };
    }
    if (!Array.isArray(res.rows)) {
      return {
        state: 'error',
        message: '检索失败：返回结果格式异常（这不是没有匹配）',
        rows: []
      };
    }
    if (!res.rows.length) {
      return { state: 'empty', message: '检索成功，没有匹配的记录。换个词再试，或回聊天框问阿寻。', rows: [] };
    }
    return {
      state: 'ok',
      message: '共 ' + res.rows.length + ' 条，按相关度排序（分级与分数来自数据库函数，未在前端重算）',
      rows: res.rows
    };
  };

  function esc(s) { return LF.ui && LF.ui.esc ? LF.ui.esc(s) : String(s == null ? '' : s); }

  /** 单条结果 HTML：编号 / 标题 / 函数给的 label / 分数 / rank 都原样展示 */
  function hitHTML(hit) {
    var it = (hit && hit.item) || {};
    var cat = LF.ui && LF.ui.categoryMeta ? LF.ui.categoryMeta(it.category) : { label: '', emoji: '📦' };
    var title = LF.ui && LF.ui.displayTitle ? LF.ui.displayTitle(it) : (it.title || '未命名物品');
    var meta = [it.time || '', cat.label ? cat.emoji + ' ' + cat.label : ''].filter(Boolean).join(' · ');
    var score = typeof hit.score === 'number' ? hit.score.toFixed(4) : String(hit.score);
    return '' +
      '<div class="item ts-item" data-id="' + esc(it.id) + '">' +
      '<div class="item-body">' +
      '<div class="item-title">LF-' + esc(it.id) + ' · ' + esc(title) +
      ' <span class="badge score">' + esc(hit.label || '') + '</span></div>' +
      (meta ? '<div class="item-meta">' + esc(meta) + '</div>' : '') +
      (LF.ui && LF.ui.noticeHTML ? LF.ui.noticeHTML(it) : '') +
      (it.pickupLocation
        ? '<div class="pickup-tag">📍 可到「' + esc(it.pickupLocation) + '」认领</div>'
        : '') +
      '<div class="hint">rank ' + esc(hit.rank) + ' · 相关度 ' + esc(score) +
      ' · ' + esc(hit.level || '') + ' · ' + esc(hit.algorithmVersion || '') + '</div>' +
      '</div></div>';
  }

  /** 渲染（纯 DOM 写入，便于测试断言） */
  LF.textSearch.render = function (res) {
    var d = LF.textSearch.describe(res);
    var hint = el(HINT);
    var list = el(LIST);
    if (hint) {
      hint.textContent = d.message;
      hint.className = 'hint' + (d.state === 'error' ? ' ts-error' : '');
    }
    if (list) {
      list.innerHTML = d.state === 'ok' ? d.rows.map(hitHTML).join('') : '';
    }
    return d;
  };

  /**
   * 执行一次检索：唯一的取数出口是 LF.api.searchItems()。
   * @param {string} raw 用户输入
   * @returns {Promise<object>} 原样返回 searchItems 的结果（便于调用方/测试断言）
   */
  LF.textSearch.run = async function (raw) {
    var q = String(raw == null ? '' : raw).trim();
    var btn = el(BUTTON);
    var input = el(INPUT);

    if (!q) {
      LF.textSearch.render({ ok: false, code: 'empty_query', error: '请先输入关键词' });
      return { ok: false, code: 'empty_query', error: '请先输入关键词' };
    }

    if (!LF.api || typeof LF.api.searchItems !== 'function') {
      var missing = { ok: false, code: 'api_missing', error: '数据层没有 searchItems（api.js 未加载）' };
      LF.textSearch.render(missing);
      return missing;
    }

    var prev = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 检索中…'; }
    try {
      // 只传原话：trim + p_keywords=[] 都在 api.searchItems 里统一做，
      // 保证网页和智能体对同一句输入调的是同一组参数。
      var res = await LF.api.searchItems(q, 10);
      LF.textSearch.render(res);
      return res;
    } catch (e) {
      // searchItems 承诺不抛错，但真抛了也不能吞成「没有匹配」
      console.error('[textSearch] searchItems threw', e);
      var bad = { ok: false, code: 'unexpected', error: (e && (e.message || e)) || '未知错误' };
      LF.textSearch.render(bad);
      return bad;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = prev || '检索'; }
      if (input && input === document.activeElement) input.blur();
    }
  };

  /** 按开关挂载；关闭时保持卡片隐藏、不建任何监听 */
  LF.textSearch.mount = function () {
    var card = el(CARD);
    var on = LF.textSearch.enabled();
    LF.textSearch.mounted = on;
    if (!on) {
      if (card) card.hidden = true;
      return false;
    }
    if (card) card.hidden = false;

    var btn = el(BUTTON);
    var input = el(INPUT);
    if (btn) btn.addEventListener('click', function () { LF.textSearch.run(input ? input.value : ''); });
    if (input) input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); LF.textSearch.run(input.value); }
    });
    return true;
  };

  document.addEventListener('DOMContentLoaded', function () { LF.textSearch.mount(); });
})();
