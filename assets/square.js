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
 *   LF.square.render()   重新拉取并渲染（切到广场 tab、点刷新时调用）
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
        '<div class="item square-item">' +
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
        '</div>' +
        '</div></div>';
    }).join('');
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
  }

  document.addEventListener('DOMContentLoaded', function () {
    bind();
    LF.square.render();   // 首页就预热一次，切过去不空
  });
})();
