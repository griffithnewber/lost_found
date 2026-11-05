/**
 * assets/mailbox.js —— 用户信箱（A 拥有）
 *
 * 每个登录用户都有信箱：一个会话列表。
 * 凡是「我发布的物品收到的留言」或「我发出的留言」，都归入同一个会话，
 * 按物品分组、按最近时间排序；点开即进入对应视角的对话线程。
 *
 * 对外接口：LF.mailbox.render()
 */
(function () {
  'use strict';

  LF.mailbox = {};

  function el(id) { return document.getElementById(id); }
  function esc(s) { return LF.ui.esc(s); }

  function fmtTime(s) {
    if (!s) return '';
    var d = new Date(s);
    return isNaN(d.getTime()) ? s : d.toLocaleString('zh-CN', { hour12: false });
  }

  LF.mailbox.render = async function () {
    var box = el('mailbox-body');
    if (!box) return;

    var me = LF.api.ownerId();
    var loggedIn = !!(LF.auth && LF.auth.userId());

    if (!loggedIn) {
      box.innerHTML = '<div class="empty">登录后才能使用信箱<br>' +
        '<span class="hint">你的收件和发件会跟着账号走，换电脑登录也能看到</span><br>' +
        '<button class="ghost" id="mb-login" style="margin-top:10px">登录 / 注册</button></div>';
      var lb = el('mb-login');
      if (lb) lb.addEventListener('click', LF.auth.openDialog);
      return;
    }

    box.innerHTML = '<div class="empty">正在加载信箱…</div>';

    var items = await LF.api.listItems();
    var msgs = await LF.api.listMessages();
    var byId = {};
    items.forEach(function (it) { byId[it.id] = it; });

    // 与我相关的会话：我发布的物品收到留言，或我发出的留言
    var threads = {};   // itemId -> [msg]
    msgs.forEach(function (m) {
      var it = byId[m.itemId];
      if (!it) return;
      var involved = m.senderId === me || (it.ownerId === me && m.senderId !== me);
      if (involved) (threads[m.itemId] = threads[m.itemId] || []).push(m);
    });

    var ids = Object.keys(threads).sort(function (a, b) {
      var ta = threads[a][threads[a].length - 1].createdAt || '';
      var tb = threads[b][threads[b].length - 1].createdAt || '';
      return ta < tb ? 1 : -1;                      // 最近有动静的排前面
    });

    if (!ids.length) {
      box.innerHTML = '<div class="empty">信箱还是空的<br>' +
        '<span class="hint">你发布的物品被人留言、或你去联系别人后，会话会出现在这里</span></div>';
      return;
    }

    box.innerHTML = '<h4 class="mb-h">📬 全部会话（跟着账号走，换设备也能看）</h4>' + ids.map(function (id) {
      var it = byId[id];
      var list = threads[id];
      // 取时间最新的一条作为摘要（防止消息到达顺序与时间顺序不一致）
      var last = list.slice().sort(function (a, b) {
        return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1;
      }).pop();
      var mine = last.senderId === me;
      return '' +
        '<div class="item mb-item' + (it.status === 'returned' ? ' archived' : '') + '">' +
        (it.image ? '<img class="thumb" src="' + it.image + '" alt="">' : '<div class="thumb"></div>') +
        '<div class="item-body">' +
        '<div class="item-title">' + esc(it.title) +
        (it.status === 'returned' ? ' <span class="badge">已完成</span>' : ' <span class="badge score">进行中</span>') +
        '</div>' +
        '<div class="item-meta">' + list.length + ' 条 · 最近：' + esc(fmtTime(last.createdAt)) + '</div>' +
        '<div class="item-desc">' + esc((mine ? '我：' : '对方：') + last.content).slice(0, 60) + '</div>' +
        '<button class="ghost" style="margin-top:8px" data-mb-open="' + id + '">打开对话</button>' +
        '</div></div>';
    }).join('');

    box.querySelectorAll('[data-mb-open]').forEach(function (b) {
      b.addEventListener('click', function () {
        var it = byId[Number(b.getAttribute('data-mb-open'))];
        if (!it) return;
        // 我是发布者 → 发布者视角（可回复、可确认认领）；否则 → 认领者视角
        LF.contact.openThread(it, it.ownerId === me ? 'owner' : 'finder');
      });
    });
  };

  document.addEventListener('DOMContentLoaded', function () {
    var tab = document.querySelector('.tab[data-tab="mailbox"]');
    if (tab) tab.addEventListener('click', function () { LF.mailbox.render(); });
    LF.mailbox.render();
  });
  document.addEventListener('lf:auth', function () { LF.mailbox.render(); });
  document.addEventListener('lf:changed', function () { LF.mailbox.render(); });
})();
