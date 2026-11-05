/**
 * assets/contact.js —— 认领联系闭环（A 拥有）
 *
 * 解决什么问题：
 *   以前 AI 确认通过后只提示一句“请留意发布者联系”，失主根本收不到任何东西。
 *   这个模块把「找到东西的人 → 留言 → 失主在“我的发布”里看到 → 回复/确认找回 → 物品从广场下架」
 *   做成真正可用的闭环。
 *
 * 对外接口：
 *   LF.contact.attachFinderEntry(item)   在确认成功的结果区追加「给失主留言」按钮
 *   LF.contact.openFinder(item)          打开“给失主留言”表单
 *   LF.contact.openThread(item)          失主视角：查看该物品的全部留言、回复、标记已找回
 *   LF.contact.refreshBadges()           刷新“我的发布”里每个物品的留言数角标
 *
 * 约定（B 改渲染结构时请保留这两个属性，事件委托靠它们工作）：
 *   <button data-thread="物品id">💬 留言</button>      → 打开失主留言线程
 *   <button data-contact="物品id">✉️ 联系失主</button> → 找东西的人主动留言
 *   <span data-msgcount="物品id"></span>               → 留言数会被自动写入
 */
(function () {
  'use strict';

  LF.contact = {};

  var mask = null;

  function esc(s) { return LF.ui.esc(s); }

  function ensureModal() {
    if (mask) return mask;
    mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.id = 'contact-modal';
    mask.innerHTML = '' +
      '<div class="modal">' +
      '<button class="modal-close" id="contact-close" title="关闭">✕</button>' +
      '<h3 id="contact-title">联系失主</h3>' +
      '<div class="hint" id="contact-sub"></div>' +
      '<div id="contact-body"></div>' +
      '</div>';
    document.body.appendChild(mask);
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    document.getElementById('contact-close').addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && mask.classList.contains('show')) close();
    });
    return mask;
  }

  function open(title, sub) {
    ensureModal();
    document.getElementById('contact-title').textContent = title;
    document.getElementById('contact-sub').textContent = sub || '';
    document.getElementById('contact-body').innerHTML = '';
    mask.classList.add('show');
    return document.getElementById('contact-body');
  }

  function close() {
    if (mask) mask.classList.remove('show');
  }
  LF.contact.close = close;

  function fmtTime(s) {
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleString('zh-CN', { hour12: false });
  }

  /* ================= 找东西的人：给失主留言 ================= */
  LF.contact.openFinder = function (item) {
    var isFound = item.postType === 'found';
    var box = open('✉️ 给发布者留言', isFound
      ? '这件物品是拾到的人发布的。留言会出现在对方「我的发布」和信箱里。'
      : '留言会出现在发布者的「我的发布」和信箱里，只有对方能看到你的联系方式。');
    box.innerHTML = '' +
      '<div class="thread-item">' +
      '<div class="thread-title">' + esc(item.title) + '</div>' +
      '<div class="hint">' + (isFound
        ? '建议写清楚：你大概什么时候、在哪里丢的，物品有什么特征，方便对方核对。'
        : '建议写清楚：你什么时候、在哪里捡到的，以及你希望怎么交接。') + '</div>' +
      '</div>' +
      '<label>你的称呼</label>' +
      '<input type="text" id="ct-name" placeholder="例：三教 202 的王同学" maxlength="40">' +
      '<label>联系方式（微信 / 手机 / 邮箱，必填）</label>' +
      '<input type="text" id="ct-contact" placeholder="例：微信 wang_2024" maxlength="80">' +
      '<label>留言内容</label>' +
      '<textarea id="ct-content" maxlength="500" placeholder="例：我在图书馆三楼东侧靠窗座位捡到，可以明天中午在图书馆门口交接。"></textarea>' +
      '<button id="ct-send">发送给失主</button>' +
      '<div class="hint" style="margin-top:8px">⚠️ 请勿在留言中索要报酬；遇到可疑索要钱财的情况请直接联系学校保卫处。</div>';

    var btn = document.getElementById('ct-send');
    btn.addEventListener('click', async function () {
      var name = document.getElementById('ct-name').value.trim();
      var contact = document.getElementById('ct-contact').value.trim();
      var content = document.getElementById('ct-content').value.trim();
      if (!contact) { LF.ui.toast('请填写联系方式，否则失主无法联系你', 'error'); return; }
      if (!content) { LF.ui.toast('请填写留言内容', 'error'); return; }

      btn.disabled = true; btn.textContent = '发送中…';
      var res = await LF.api.sendMessage({
        itemId: item.id, role: 'finder', name: name, contact: contact, content: content,
        senderId: LF.api.ownerId()
      });
      btn.disabled = false; btn.textContent = '发送给失主';

      if (!res.ok) { LF.ui.toast('留言发送失败：' + res.error, 'error', 3500); return; }

      document.getElementById('contact-body').innerHTML = '' +
        '<div class="match-box">' +
        '<div>✅ 留言已送达失主。</div>' +
        '<div style="margin-top:6px">失主会在网站的“我的发布 → 💬 留言”里看到，并通过你留的联系方式找你。</div>' +
        '<div style="margin-top:6px;color:#888">如果 24 小时没有回应，可以再补充一条更具体的描述。</div>' +
        '</div>' +
        '<button id="ct-done">好的</button>';
      document.getElementById('ct-done').addEventListener('click', close);
      LF.ui.toast('✅ 留言已发送给失主', 'success');
      LF.contact.refreshBadges();
    });
  };

  /* ================= 发布者 / 认领者：查看留言线程 =================
   * viewerRole：'owner'（发布者视角，可回复、可确认认领）
   *             'finder'（认领者视角，看自己发的留言和对方回复）
   */
  LF.contact.openThread = async function (item, viewerRole) {
    viewerRole = viewerRole || 'owner';
    var me = LF.api.ownerId();
    var isOwnerView = viewerRole === 'owner';
    var box = open(
      '💬『' + item.title + '』的留言',
      isOwnerView ? '只有你自己会在这里处理留言；确认后物品会从广场下架。'
                  : '这里是你发出的留言和对方的回复。'
    );
    box.innerHTML = '<div class="hint">加载留言中…</div>';

    var msgs = await LF.api.listMessages(item.id);

    var html = '';
    if (item.status === 'returned') {
      html += '<div class="thread-item" style="background:#f2f4f8">该物品已完成认领，已从广场下架。</div>';
    }
    if (!msgs.length) {
      html += '<div class="empty">' + (isOwnerView ? '还没有人留言。可以把物品名称和大致地点发到班级群，让捡到的人来这里留言。' : '你还没有给这条物品留过言。') + '</div>';
    } else {
      html += '<div class="thread">' + msgs.map(function (m) {
        var mine = m.senderId ? m.senderId === me : (isOwnerView ? m.role === 'owner' : m.role === 'finder');
        var who = mine ? '我'
          : (m.role === 'owner' ? '发布者' : '认领的人' + (m.name ? ' · ' + m.name : ''));
        return '' +
          '<div class="thread-item' + (mine ? ' owner' : '') + '">' +
          '<div class="thread-title">' + who +
          '<span class="thread-time">' + esc(fmtTime(m.createdAt)) + '</span></div>' +
          '<div class="thread-content">' + esc(m.content) + '</div>' +
          (!mine && m.contact ? '<div class="thread-contact">📮 ' + esc(m.contact) + '</div>' : '') +
          '</div>';
      }).join('') + '</div>';
    }

    var canConfirm = isOwnerView && item.ownerId === LF.api.ownerId() && item.status !== 'returned';
    html += '' +
      '<label style="margin-top:14px">' + (isOwnerView ? '回复对方' : '补充留言') + '</label>' +
      '<textarea id="ct-reply" maxlength="500" placeholder="' + (isOwnerView ? '例：谢谢你！我明天中午 12 点在图书馆门口等你。' : '例：补充一下物品的特征…') + '"></textarea>' +
      '<div class="thread-actions">' +
      '<button class="ghost" id="ct-reply-send">发送</button>' +
      (canConfirm ? '<button class="btn-del" id="ct-returned">✅ 确认认领，广场下架</button>' : '') +
      '</div>';

    box.innerHTML = html;

    var sendBtn = document.getElementById('ct-reply-send');
    if (sendBtn) sendBtn.addEventListener('click', async function () {
      var text = document.getElementById('ct-reply').value.trim();
      if (!text) { LF.ui.toast('请先输入内容', 'error'); return; }
      sendBtn.disabled = true; sendBtn.textContent = '发送中…';
      var res = await LF.api.sendMessage({
        itemId: item.id, role: isOwnerView ? 'owner' : 'finder',
        name: isOwnerView ? '发布者' : (LF.auth.username() || ''),
        contact: '', content: text, senderId: me
      });
      sendBtn.disabled = false; sendBtn.textContent = '发送';
      if (!res.ok) { LF.ui.toast('发送失败：' + res.error, 'error', 3000); return; }
      LF.ui.toast('已发出', 'success');
      LF.contact.openThread(item, viewerRole);
    });

    var btnReturned = document.getElementById('ct-returned');
    if (btnReturned) btnReturned.addEventListener('click', async function () {
      if (!window.confirm('确认匹配完成？确认后这条记录会从广场下架（仍保留在你的“我的发布”里）。')) return;
      btnReturned.disabled = true; btnReturned.textContent = '处理中…';
      var res = await LF.api.updateItem(item.id, { status: 'returned', claimAt: new Date().toISOString() });
      if (!res.ok) {
        btnReturned.disabled = false; btnReturned.textContent = '✅ 确认认领，广场下架';
        LF.ui.toast('操作失败：' + res.error, 'error', 3000);
        return;
      }
      LF.ui.toast('🎉 已确认认领，物品已从广场下架', 'success');
      close();
      document.dispatchEvent(new CustomEvent('lf:changed'));
    });

    if (msgs.length) LF.contact.refreshBadges();
  };

  /* ================= 入口 1：确认成功后追加「留言」按钮 ================= */
  LF.contact.attachFinderEntry = function (item) {
    var action = document.getElementById('modal-action');
    if (!action) return;
    var wrap = document.createElement('div');
    wrap.className = 'thread-entry';
    wrap.innerHTML = '<button class="ghost" id="match-contact">✉️ 给' + (item.postType === 'found' ? '拾者' : '失主') + '留言（推荐）</button>' +
      '<div class="hint">留言后对方会看到你的联系方式，比你干等更快。</div>';
    action.appendChild(wrap);
    document.getElementById('match-contact').addEventListener('click', function () {
      LF.ui.closeModal();
      LF.contact.openFinder(item);
    });
  };

  /* ================= 入口 2：卡片上的留言数角标 ================= */
  LF.contact.refreshBadges = async function () {
    var slots = document.querySelectorAll('[data-msgcount]');
    if (!slots.length) return;
    var msgs = await LF.api.listMessages();
    var count = {};
    msgs.forEach(function (m) {
      if (m.role === 'owner') return;
      count[m.itemId] = (count[m.itemId] || 0) + 1;
    });
    Array.prototype.forEach.call(slots, function (s) {
      var n = count[Number(s.getAttribute('data-msgcount'))] || 0;
      s.textContent = n ? ('💬 ' + n) : '';
      s.className = 'badge' + (n ? '' : ' hidden');
    });
  };

  /* ================= 事件委托 ================= */
  document.addEventListener('click', async function (e) {
    var threadBtn = e.target.closest('[data-thread]');
    var contactBtn = e.target.closest('[data-contact]');
    if (!threadBtn && !contactBtn) return;

    var id = Number((threadBtn || contactBtn).getAttribute(threadBtn ? 'data-thread' : 'data-contact'));
    var items = await LF.api.listItems();
    var item = items.filter(function (x) { return x.id === id; })[0];
    if (!item) { LF.ui.toast('该记录已不存在', 'error'); return; }

    if (threadBtn) LF.contact.openThread(item);
    else LF.contact.openFinder(item);
  });

  document.addEventListener('DOMContentLoaded', function () {
    ensureModal();
    setTimeout(function () { LF.contact.refreshBadges(); }, 1200);
  });
})();
