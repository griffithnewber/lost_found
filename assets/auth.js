/**
 * assets/auth.js —— 用户注册 / 登录（A 拥有）
 *
 * 方案：用户名 + 密码，密码经「随机盐 + SHA-256」哈希后存云端 users 表。
 * 原型阶段够用；注意哈希表可被公开读取（RLS 开放），正式版应改为服务端校验。
 *
 * 对外接口：
 *   LF.auth.user()      -> {userId, username} | null
 *   LF.auth.userId()    -> string | null    （api.ownerId 会优先用它）
 *   LF.auth.register(u, p) / login(u, p) / logout()
 *
 * 登录/登出后广播 'lf:auth' 事件，app.js / square.js / mailbox.js 监听刷新。
 */
(function () {
  'use strict';

  LF.auth = {};
  var STORE_KEY = 'lf_auth_user';
  var mask = null;

  function el(id) { return document.getElementById(id); }

  /* ---------- 状态 ---------- */
  function read() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); }
    catch (e) { return null; }
  }
  LF.auth.user = read;
  LF.auth.userId = function () {
    var u = read();
    return u ? u.userId : null;
  };
  LF.auth.username = function () {
    var u = read();
    return u ? u.username : null;
  };

  /* ---------- 密码哈希 ---------- */
  async function hash(password, salt) {
    var data = new TextEncoder().encode(salt + ':' + password);
    var digest = await crypto.subtle.digest('SHA-256', data);
    return Array.prototype.map.call(new Uint8Array(digest), function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  }

  function makeSalt() {
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  }

  function db() { return LF.api.getCloud().database; }

  /* ---------- 注册 / 登录 ---------- */
  LF.auth.register = async function (username, password) {
    username = String(username || '').trim();
    password = String(password || '');
    if (!/^[\u4e00-\u9fa5a-zA-Z0-9_]{2,20}$/.test(username)) {
      return { ok: false, error: '用户名需 2-20 位中英文、数字或下划线' };
    }
    if (password.length < 6) return { ok: false, error: '密码至少 6 位' };

    var exists = await db().from('users').select('id').ilike('username', username).limit(1);
    if (exists.error) return { ok: false, error: exists.error.message };
    if (exists.data && exists.data.length) return { ok: false, error: '这个用户名已被注册' };

    var salt = makeSalt();
    var passHash = await hash(password, salt);
    var res = await db().from('users').insert({
      username: username, pass_salt: salt, pass_hash: passHash
    }).select();
    if (res.error) return { ok: false, error: res.error.message };

    var u = { userId: 'u_' + username.toLowerCase(), username: username };
    localStorage.setItem(STORE_KEY, JSON.stringify(u));
    afterAuth(u);
    return { ok: true, user: u };
  };

  LF.auth.login = async function (username, password) {
    username = String(username || '').trim();
    var res = await db().from('users').select('*').ilike('username', username).limit(1);
    if (res.error) return { ok: false, error: res.error.message };
    if (!res.data || !res.data.length) return { ok: false, error: '用户不存在，请先注册' };

    var row = res.data[0];
    var passHash = await hash(String(password), row.pass_salt);
    if (passHash !== row.pass_hash) return { ok: false, error: '密码不对，再试试' };

    var u = { userId: 'u_' + row.username.toLowerCase(), username: row.username };
    localStorage.setItem(STORE_KEY, JSON.stringify(u));
    afterAuth(u);
    return { ok: true, user: u };
  };

  LF.auth.logout = function () {
    localStorage.removeItem(STORE_KEY);
    document.dispatchEvent(new CustomEvent('lf:auth'));
  };

  /* ---------- 强制登录闸门 ----------
   * LF.auth.require('为什么需要登录', function () { 登录后接着做的事 })
   *   已登录：直接执行回调并返回 true
   *   未登录：弹登录框、记住回调；登录/注册成功后自动接着执行，返回 false
   */
  var pending = null;

  LF.auth.require = function (why, onDone) {
    if (LF.auth.userId()) { if (onDone) onDone(); return true; }
    pending = onDone || null;
    if (why) LF.ui.toast(why, 'info', 3200);
    LF.auth.openDialog();
    return false;
  };

  function runPending() {
    var fn = pending;
    pending = null;
    if (typeof fn === 'function') setTimeout(fn, 0);
  }

  /* 登录成功后，把本机匿名发布的记录归到账号名下（否则那些记录会变成孤儿） */
  async function adoptLocalPosts() {
    if (!LF.api || !LF.api.adoptLocalItems) return;
    var n = await LF.api.adoptLocalItems();
    if (n > 0) {
      LF.ui.toast('已把本机匿名发布的 ' + n + ' 条记录归到你的账号下', 'success', 3600);
      document.dispatchEvent(new CustomEvent('lf:changed'));
    }
  }

  function afterAuth(user) {
    document.dispatchEvent(new CustomEvent('lf:auth'));
    adoptLocalPosts();
    runPending();
  }

  /* ---------- 顶部入口 UI ---------- */
  LF.auth.renderBar = function () {
    var area = el('auth-area');
    if (!area) return;
    var u = read();
    if (u) {
      area.innerHTML = '<span class="auth-user">👤 ' + LF.ui.esc(u.username) + '</span>' +
        '<a href="javascript:void(0)" id="auth-logout" class="auth-link">退出</a>';
      el('auth-logout').addEventListener('click', function () {
        LF.auth.logout();
        LF.ui.toast('已退出登录', 'info');
      });
    } else {
      area.innerHTML = '<a href="javascript:void(0)" id="auth-open" class="auth-link">登录 / 注册</a>';
      el('auth-open').addEventListener('click', LF.auth.openDialog);
    }
  };

  /* ---------- 登录 / 注册弹窗 ---------- */
  LF.auth.openDialog = function () {
    if (!mask) {
      mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.id = 'auth-modal';
      mask.innerHTML = '' +
        '<div class="modal">' +
        '<button class="modal-close" id="auth-close" title="关闭">✕</button>' +
        '<h3>登录 / 注册</h3>' +
        '<div class="hint">只需要用户名和密码。发布、留言、认领、信箱都需要先登录，数据跟着账号走，换电脑也能看到。</div>' +
        '<div class="auth-tabs">' +
        '<button class="ghost auth-tab active" data-mode="login">登录</button>' +
        '<button class="ghost auth-tab" data-mode="register">注册</button>' +
        '</div>' +
        '<label>用户名</label>' +
        '<input type="text" id="auth-username" maxlength="20" placeholder="2-20 位中英文、数字或下划线" autocomplete="username">' +
        '<label>密码</label>' +
        '<input type="password" id="auth-password" maxlength="60" placeholder="至少 6 位" autocomplete="current-password">' +
        '<button id="auth-submit">登录</button>' +
        '<div class="hint" id="auth-error" style="color:#c62828"></div>' +
        '</div>';
      document.body.appendChild(mask);
      mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
      el('auth-close').addEventListener('click', close);

      var mode = 'login';
      mask.querySelectorAll('.auth-tab').forEach(function (t) {
        t.addEventListener('click', function () {
          mode = t.getAttribute('data-mode');
          mask.querySelectorAll('.auth-tab').forEach(function (x) { x.classList.remove('active'); });
          t.classList.add('active');
          el('auth-submit').textContent = mode === 'login' ? '登录' : '注册并登录';
          el('auth-error').textContent = '';
        });
      });

      el('auth-submit').addEventListener('click', async function () {
        var btn = el('auth-submit');
        var name = el('auth-username').value.trim();
        var pass = el('auth-password').value;
        el('auth-error').textContent = '';
        btn.disabled = true; btn.textContent = mode === 'login' ? '登录中…' : '注册中…';
        var res = mode === 'login' ? await LF.auth.login(name, pass) : await LF.auth.register(name, pass);
        btn.disabled = false; btn.textContent = mode === 'login' ? '登录' : '注册并登录';
        if (!res.ok) { el('auth-error').textContent = res.error; return; }
        close();
        LF.ui.toast('👋 欢迎，' + res.user.username, 'success');
      });
    }
    mask.classList.add('show');
    el('auth-username').focus();
  };

  function close() {
    if (mask) mask.classList.remove('show');
    pending = null;   // 用户主动关掉登录框，就别在以后某次登录时再偷偷执行旧动作
  }

  document.addEventListener('DOMContentLoaded', function () {
    LF.auth.renderBar();
    // 历史上的匿名发布：已登录状态下打开页面也补一次归属，避免那条记录永远没人能管
    if (LF.auth.userId()) adoptLocalPosts();
  });
  document.addEventListener('lf:auth', function () {
    LF.auth.renderBar();
  });
})();
