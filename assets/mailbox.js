/**
 * assets/mailbox.js —— 用户信箱（A 拥有）
 *
 * 每个登录用户都有信箱，两个分区：
 *   收件：我发布的物品收到的留言（我是发布者）→ 打开即发布者视角线程
 *   发件：我以认领者身份发出的留言 → 打开即认领者视角线程
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

    var received = {};   // itemId -> [msg]  我发布的物品收到的
    var sent = {};       // itemId -> [msg]  我发出去的
    msgs.forEach(function (m) {
      var it = byId[m.itemId];
      if (!it) return;
      if (it.ownerId === me && m.senderId !== me) {
        (received[m.itemId] = received[m.itemId] || []).push(m);
      }
      if (m.senderId === me) {
        (sent[m.itemId] = sent[m.itemId] || []).push(m);
      }
    });

    function section(title, groups, viewerRole) {
      var ids = Object.keys(groups);
      if (!ids.length) {
        return '<h4 class="mb-h">' + title + '</h4><div class="empty mb-sub">暂无</div>';
      }
      return '<h4 class="mb-h">' + title + '</h4>' + ids.map(function (id) {
        var it = byId[id];
        var list = groups[id];
        var last = list[list.length - 1];
        return '' +
          '<div class="item mb-item">' +
          (it.image ? '<img class="thumb" src="' + it.image + '" alt="">' : '<div class="thumb"></div>') +
          '<div class="item-body">' +
          '<div class="item-title">' + esc(it.title) +
          (it.status === 'returned' ? ' <span class="badge">已完成</span>' : ' <span class="badge score">进行中</span>') +
          '</div>' +
          '<div class="item-meta">' + list.length + ' 条 · 最近：' + esc(fmtTime(last.createdAt)) + '</div>' +
          '<div class="item-desc">' + esc((last.senderId === me ? '我：' : '对方：') + last.content).slice(0, 60) + '</div>' +
          '<button class="ghost" style="margin-top:8px" data-mb-open="' + id + '" data-mb-role="' + viewerRole + '">打开对话</button>' +
          '</div></div>';
      }).join('');
    }

    box.innerHTML =
      section('📥 收件（我发布的物品收到的留言）', received, 'owner') +
      '<div style="height:18px"></div>' +
      section('📤 发件（我发出的认领留言）', sent, 'finder');

    box.querySelectorAll('[data-mb-open]').forEach(function (b) {
      b.addEventListener('click', function () {
        var it = byId[Number(b.getAttribute('data-mb-open'))];
        var role = b.getAttribute('data-mb-role');
        if (it) LF.contact.openThread(it, role);
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
