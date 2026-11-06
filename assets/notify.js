/**
 * assets/notify.js —— 新留言提醒（A 拥有）
 *
 * 解决的问题：
 *   智能体没有定时器、也没有上一轮对话的记忆，所以它**永远不会主动告诉你**
 *   「有人给你留言了」。这句话只能是假的，只能由网页侧兜住：
 *     - 登录后每 30 秒查一次「与我相关的会话」（我是发布者，或我在里面发过言）
 *     - 出现对方发来的新消息 → 信箱 tab 红点 + 标题角标 + 站内提示 + 可选桌面通知
 *
 * 这只是「页面开着时有效」的近似推送。真正的离线推送要接短信/微信/云函数，
 * 成本和合规都不划算，作品里就把它诚实地讲成「站内提醒 + 桌面通知」。
 *
 * 对外接口：
 *   LF.notify.check()            查一次（轮询内部调用，也可手动触发）
 *   LF.notify.askPermission()    请求桌面通知权限（信箱里那个「开启提醒」按钮）
 */

(function () {
  'use strict';

  LF.notify = {};

  var SEEN_KEY = 'lf_msg_seen_at';
  var BASE_TITLE = document.title || '失物招领 · 智能匹配';
  var POLL_MS = 30000;
  var timer = null;
  var unread = 0;

  function getSeen() {
    try { return localStorage.getItem(SEEN_KEY) || ''; } catch (e) { return ''; }
  }
  function setSeen(t) {
    try { localStorage.setItem(SEEN_KEY, t); } catch (e) { /* 忽略 */ }
  }
  function loggedIn() {
    return !!(window.LF && LF.auth && LF.auth.userId && LF.auth.userId());
  }

  /* ---------- 信箱 tab 红点 ---------- */
  function paintBadge(n) {
    var tab = document.querySelector('.tab[data-tab="mailbox"]');
    if (!tab) return;
    var dot = tab.querySelector('.mb-dot');
    if (!n) {
      if (dot) dot.parentNode.removeChild(dot);
      document.title = BASE_TITLE;
      return;
    }
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'mb-dot';
      tab.appendChild(dot);
    }
    dot.textContent = String(n);
    document.title = '(' + n + ') ' + BASE_TITLE;
  }
  LF.notify.paintBadge = paintBadge;

  /* ---------- 桌面通知 ---------- */
  LF.notify.askPermission = function () {
    if (!window.Notification) {
      LF.ui.toast('这个浏览器不支持桌面通知，站内红点仍然有效', 'error', 3000);
      return;
    }
    if (Notification.permission === 'granted') {
      LF.ui.toast('桌面提醒已经开着了', 'success', 1600);
      return;
    }
    Notification.requestPermission().then(function (p) {
      LF.ui.toast(
        p === 'granted' ? '已开启：有人留言会弹桌面提醒' : '没开成，站内红点和信箱仍然有效',
        p === 'granted' ? 'success' : 'info', 2600
      );
    }).catch(function () { /* 忽略 */ });
  };

  /* ---------- 主检查 ---------- */
  LF.notify.check = async function () {
    if (!loggedIn()) return;
    var me = LF.api.ownerId();

    var items = await LF.api.listItems();
    if (!items || !items.length) return;
    var byId = {};
    items.forEach(function (it) { byId[it.id] = it; });

    var msgs = await LF.api.listMessages();
    if (!msgs || !msgs.length) return;

    // 我参与的会话 = 我是发布者 ∪ 我在里面发过言（两遍扫描，缺一不可）
    var mine = {};
    msgs.forEach(function (m) {
      var it = byId[m.itemId];
      if (it && (it.ownerId === me || m.senderId === me)) mine[m.itemId] = true;
    });

    var seen = getSeen();
    // 从没跑过时用「24 小时前」当基准：既不会把三个月前的老消息全轰一遍，
    // 也不至于让第一次打开的人错过今天刚到的留言。
    var seenTs = seen ? new Date(seen).getTime() : (Date.now() - 86400000);
    if (isNaN(seenTs)) seenTs = Date.now() - 86400000;

    var latest = '';
    var fresh = [];
    msgs.forEach(function (m) {
      if (!mine[m.itemId]) return;
      var t = m.createdAt || '';
      var mt = new Date(t).getTime();
      if (t && t > latest) latest = t;
      if (m.senderId === me) return;      // 自己发的不提醒
      if (isNaN(mt) || mt <= seenTs) return;
      fresh.push(m);
    });

    if (latest) setSeen(latest);
    if (!fresh.length) return;

    unread = fresh.length;
    paintBadge(unread);

    var last = fresh[fresh.length - 1];
    var it = byId[last.itemId];
    LF.ui.toast('📬 有人给你留言：' + (it ? it.title : '一条记录') +
      (unread > 1 ? '（共 ' + unread + ' 条新消息）' : ''), 'info', 5200);

    if (window.Notification && Notification.permission === 'granted') {
      try {
        new Notification('失物招领 · 有人给你留言', {
          body: (it ? it.title + '：' : '') + String(last.content || '').slice(0, 40),
          tag: 'lf-msg'
        });
      } catch (e) { /* 通知失败不影响站内提示 */ }
    }

    // 正停在信箱页就顺手刷新，不用用户自己点
    var mbPanel = document.getElementById('panel-mailbox');
    if (mbPanel && mbPanel.classList.contains('active') && LF.mailbox) LF.mailbox.render();
  };

  /* ---------- 轮询 ---------- */
  function start() {
    stop();
    if (!loggedIn()) return;
    LF.notify.check();                       // 先跑一次，建立基准时间
    timer = setInterval(function () {
      if (document.hidden) return;           // 后台不查，省流量也省云库配额
      LF.notify.check();
    }, POLL_MS);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  LF.notify.start = start;
  LF.notify.stop = stop;

  document.addEventListener('DOMContentLoaded', function () {
    if (loggedIn()) start();

    // 点开信箱就当作已读：清红点与标题角标
    var tab = document.querySelector('.tab[data-tab="mailbox"]');
    if (tab) tab.addEventListener('click', function () {
      unread = 0;
      paintBadge(0);
    });

    // 页面重新可见时补查一次（后台期间可能来了消息）
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && loggedIn()) LF.notify.check();
    });
  });

  document.addEventListener('lf:auth', function () {
    paintBadge(0);
    start();
  });
})();
