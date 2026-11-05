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

  LF.auth.user = function () { return read(); };
  LF.auth.userId = function () {
    var u = read();
    return u ? u.userId : null;
  };
  LF.auth.username = function () {
    var u = read();
    return u ? u.username : null;
  };

  /* ---------- 状态 ----------
   * 正常情况写 localStorage；隐私模式 / 存储被禁时 setItem 会抛错，
   * 此时退回内存态（本次会话仍有效），绝不让登录流程崩掉。
   */
  var memUser = null;

  function saveUser(u) {
    memUser = u || null;
    try {
      if (u) localStorage.setItem(STORE_KEY, JSON.stringify(u));
      else localStorage.removeItem(STORE_KEY);
    } catch (e) { /* 存储被禁：内存兜底 */ }
  }

  function read() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return memUser;
  }

  /* ---------- 错误翻译：云端报错多是英文，直接给人看会以为"没反应" ---------- */
  function friendly(err, fallback) {
    var m = err && (err.message || err.msg) || (typeof err === 'string' ? err : '') || '';
    m = String(m);
    if (/duplicate|unique/i.test(m)) return '这个用户名刚被别人注册了，换一个试试';
    if (/permission denied/i.test(m)) return '云端暂时拒绝写入，稍等几秒再试一次';
    if (/fetch|network|timeout|Failed to fetch|load failed/i.test(m)) return '网络不通或云端超时，检查网络后重试';
    return m ? (fallback + '：' + m) : fallback;
  }

  /* ---------- 密码哈希 ----------
   * crypto.subtle 只在 HTTPS / localhost 可用（有些内置浏览器、http 环境没有），
   * 没有时降级为纯 JS 的 SHA-256，结果完全一致。
   */
  function sha256Hex(str) {
    str = unescape(encodeURIComponent(str));          // 先转 UTF-8 字节串，中文密码也能算对
    var rr = function (v, a) { return (v >>> a) | (v << (32 - a)); };
    var mathPow = Math.pow, maxWord = mathPow(2, 32), result = '';
    var words = [], asciiBitLength = str.length * 8;
    var k = sha256Hex.k = sha256Hex.k || [];      // 常量表可以缓存
    var h = [];                                    // 状态表必须每次重算，否则第二次调用起结果全错
    var primeCounter = 0;
    var isComposite = {};
    for (var candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (var i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        h[primeCounter] = (mathPow(candidate, .5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    str += '\x80';
    while (str.length % 64 - 56) str += '\x00';
    for (i = 0; i < str.length; i++) {
      var cc = str.charCodeAt(i);
      words[i >> 2] |= cc << ((3 - i) % 4) * 8;
    }
    words[words.length] = ((asciiBitLength / maxWord) | 0);
    words[words.length] = (asciiBitLength);
    for (var j = 0; j < words.length;) {
      var w = words.slice(j, j += 16);
      var oldHash = h.slice(0);
      for (i = 16; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2];
        var s0 = rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3);
        var s1 = rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var temp1 = (hh + S1 + ch + k[i] + w[i]) | 0;
        var S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + temp1) | 0;
        d = c; c = b; b = a; a = (temp1 + temp2) | 0;
      }
      for (i = 0; i < 8; i++) {
        h[i] = (h[i] + [a, b, c, d, e, f, g, hh][i]) | 0;
      }
      void oldHash;
    }
    for (i = 0; i < 8; i++) {
      for (var jj = 3; jj + 1; jj--) {
        var b2 = (h[i] >> (jj * 8)) & 255;
        result += ((b2 >> 4).toString(16)) + ((b2 & 15).toString(16));
      }
    }
    return result;
  }

  async function hash(password, salt) {
    var msg = salt + ':' + password;
    if (window.crypto && window.crypto.subtle && window.isSecureContext) {
      try {
        var data = new TextEncoder().encode(msg);
        var digest = await window.crypto.subtle.digest('SHA-256', data);
        return Array.prototype.map.call(new Uint8Array(digest), function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('');
      } catch (e) { /* 落到纯 JS 实现 */ }
    }
    return sha256Hex(msg);
  }

  function makeSalt() {
    try {
      var a = new Uint8Array(16);
      crypto.getRandomValues(a);
      return Array.prototype.map.call(a, function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    } catch (e) {
      var out = '';
      for (var i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
      return out;
    }
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
    if (exists.error) return { ok: false, error: friendly(exists.error, '查询用户名失败') };
    if (exists.data && exists.data.length) {
      return { ok: false, error: '这个用户名已被注册，去「登录」页输入同样信息即可进入' };
    }

    var salt = makeSalt();
    var passHash = await hash(password, salt);
    var res = await db().from('users').insert({
      username: username, pass_salt: salt, pass_hash: passHash
    }).select();
    if (res.error) return { ok: false, error: friendly(res.error, '注册失败') };

    var u = { userId: 'u_' + username.toLowerCase(), username: username };
    saveUser(u);
    afterAuth(u);
    return { ok: true, user: u };
  };

  LF.auth.login = async function (username, password) {
    username = String(username || '').trim();
    var res = await db().from('users').select('*').ilike('username', username).limit(1);
    if (res.error) return { ok: false, error: friendly(res.error, '查询账号失败') };
    if (!res.data || !res.data.length) return { ok: false, error: '用户不存在，请先注册' };

    var row = res.data[0];
    var passHash = await hash(String(password), row.pass_salt);
    if (passHash !== row.pass_hash) return { ok: false, error: '密码不对，再试试' };

    var u = { userId: 'u_' + row.username.toLowerCase(), username: row.username };
    saveUser(u);
    afterAuth(u);
    return { ok: true, user: u };
  };

  LF.auth.logout = function () {
    saveUser(null);
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
        try {
          var res = mode === 'login' ? await LF.auth.login(name, pass) : await LF.auth.register(name, pass);
          if (!res.ok) { el('auth-error').textContent = res.error || '未知错误，请重试'; return; }
          close();
          LF.ui.toast('👋 欢迎，' + res.user.username, 'success');
        } catch (e) {
          // 任何意外异常都显示出来，绝不让按钮卡在"注册中…"
          el('auth-error').textContent = '出错了：' + ((e && e.message) ? e.message : e);
        } finally {
          btn.disabled = false; btn.textContent = mode === 'login' ? '登录' : '注册并登录';
        }
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
