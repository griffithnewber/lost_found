/**
 * assets/api.js —— 数据层（A 拥有）
 * 对外契约（B/C 只调这些，不要直接碰 cloud 对象）：
 *   LF.api.listItems()                -> Promise<Item[]>
 *   LF.api.createItem(item)           -> Promise<{ok:boolean, id?:number, error?:string}>
 *   LF.api.deleteItem(id)             -> Promise<{ok:boolean, error?:string}>
 *   LF.api.updateItem(id, patch)      -> Promise<{ok:boolean, error?:string}>
 *   LF.api.ownerId()                  -> string  本浏览器固定 ID（认领归属用）
 *   LF.api.setStatus(text, ok)        -> void    右上角连接状态（由 ui.js 实现渲染）
 *
 * Item 结构：
 *   { id, title, detail, location, image, colorFeature,
 *     aiDesc, aiTags, status, ownerId, claimAt, time, createdAt }
 *   detail / location 为隐藏字段，仅确认流程使用。
 */
(function () {
  'use strict';
  LF.api = {};

  var cloud = null;

  function getCloud() {
    if (!cloud) {
      cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: LF.config.endpoint,
        oauthRelayBaseUrl: LF.config.oauthRelayBaseUrl,
        publishableKey: LF.config.publishableKey
      });
    }
    return cloud;
  }

  var CACHE_KEY = 'lost_found_wbcloud_v1';

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]'); }
    catch (e) { return []; }
  }

  function saveCache(items) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(items)); } catch (e) { /* 缓存失败不影响主流程 */ }
  }

  function rowToItem(r) {
    return {
      id: r.id,
      title: r.title || '',
      detail: r.detail || '',
      location: r.location || '',
      image: r.image || null,
      colorFeature: r.color_feature || null,
      aiDesc: r.ai_desc || '',
      aiTags: Array.isArray(r.ai_tags) ? r.ai_tags : (r.ai_tags || []),
      notice: r.notice || '',
      category: r.category || '',
      colorTone: r.color_tone || '',
      status: r.status || 'open',
      postType: r.post_type || 'lost',
      ownerId: r.owner_id || '',
      claimAt: r.claim_at || null,
      time: r.pub_time || '',
      createdAt: r.created_at
    };
  }

  function itemToRow(item) {
    var row = {
      title: item.title,
      detail: item.detail || '',
      location: item.location || '',
      image: item.image || null,
      color_feature: item.colorFeature || null,
      ai_desc: item.aiDesc || '',
      ai_tags: item.aiTags || [],
      notice: item.notice || '',
      category: item.category || '',
      color_tone: item.colorTone || '',
      status: item.status || 'open',
      post_type: item.postType || 'lost',
      owner_id: item.ownerId || '',
      pub_time: item.time || new Date().toLocaleString('zh-CN')
    };
    return row;
  }

  LF.api.getCloud = getCloud;
  LF.api.loadCache = loadCache;

  /** 拉取全部物品（云端优先，失败回退本地缓存） */
  LF.api.listItems = async function () {
    try {
      var res = await getCloud().database.from(LF.config.table)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1000);
      if (res.error) throw res.error;
      var items = (res.data || []).map(rowToItem);
      saveCache(items);
      LF.api.setStatus('☁️ 已连接云端', true);
      return items;
    } catch (e) {
      console.error('[api] listItems failed', e);
      LF.api.setStatus('⚠️ 云端同步失败，使用本地缓存', false);
      return loadCache();
    }
  };

  LF.api.createItem = async function (item) {
    try {
      var res = await getCloud().database.from(LF.config.table)
        .insert(itemToRow(item))
        .select();
      if (res.error) throw res.error;
      var created = rowToItem(res.data[0]);
      var items = loadCache();
      items.unshift(created);
      saveCache(items);
      return { ok: true, id: created.id, item: created };
    } catch (e) {
      console.error('[api] createItem failed', e);
      return { ok: false, error: e.message || '未知错误' };
    }
  };

  LF.api.deleteItem = async function (id) {
    try {
      var res = await getCloud().database.from(LF.config.table).delete().eq('id', id);
      if (res.error) throw res.error;
      saveCache(loadCache().filter(function (x) { return x.id !== id; }));
      return { ok: true };
    } catch (e) {
      console.error('[api] deleteItem failed', e);
      return { ok: false, error: e.message || '未知错误' };
    }
  };

  /**
   * 局部更新：认领状态流转、归属、补照片等
   * patch 支持 { status, claimAt, aiDesc, aiTags, ownerId, image, colorFeature }
   */
  LF.api.updateItem = async function (id, patch) {
    var row = {};
    if ('status' in patch) row.status = patch.status;
    if ('claimAt' in patch) row.claim_at = patch.claimAt;
    if ('aiDesc' in patch) row.ai_desc = patch.aiDesc;
    if ('aiTags' in patch) row.ai_tags = patch.aiTags;
    if ('ownerId' in patch) row.owner_id = patch.ownerId;
    if ('image' in patch) row.image = patch.image;
    if ('colorFeature' in patch) row.color_feature = patch.colorFeature;
    try {
      var res = await getCloud().database.from(LF.config.table).update(row).eq('id', id);
      if (res.error) throw res.error;
      var items = loadCache().map(function (x) {
        return x.id === id ? Object.assign({}, x, patch) : x;
      });
      saveCache(items);
      return { ok: true };
    } catch (e) {
      console.error('[api] updateItem failed', e);
      return { ok: false, error: e.message || '未知错误' };
    }
  };

  /** 广场可见物品：排除已找回（status = 'returned'）的记录 */
  LF.api.listPublicItems = async function () {
    var items = await LF.api.listItems();
    return items.filter(function (x) { return x.status !== 'returned'; });
  };

  /** 我的发布：按本机 ownerId 过滤（只有自己发的才出现在“我的发布”里） */
  LF.api.listMyItems = async function () {
    var me = LF.api.ownerId();
    var items = await LF.api.listItems();
    return items.filter(function (x) { return x.ownerId === me; });
  };

  /* ================= 留言（认领联系失主） ================= */

  function rowToMsg(r) {
    return {
      id: r.id,
      itemId: Number(r.item_id),
      role: r.role || 'finder',
      name: r.name || '',
      contact: r.contact || '',
      content: r.content || '',
      senderId: r.sender_id || '',     // 必须带出：信箱「发件」分区靠它判断是不是自己发的
      createdAt: r.created_at || ''
    };
  }

  /**
   * 读取留言，itemId 为空时返回全部（用于一次性统计未读数）
   * -> Promise<Message[]>
   */
  LF.api.listMessages = async function (itemId) {
    try {
      var q = getCloud().database.from(LF.config.messageTable).select('*');
      if (itemId != null) q = q.eq('item_id', itemId);
      var res = await q.order('created_at', { ascending: true }).limit(1000);
      if (res.error) throw res.error;
      return (res.data || []).map(rowToMsg);
    } catch (e) {
      console.error('[api] listMessages failed', e);
      return [];
    }
  };

  /**
   * 发送一条留言
   * msg = { itemId, role: 'finder'|'owner', name, contact, content }
   * -> Promise<{ok, error?}>
   */
  LF.api.sendMessage = async function (msg) {
    try {
      var res = await getCloud().database.from(LF.config.messageTable).insert({
        item_id: msg.itemId,
        role: msg.role || 'finder',
        name: msg.name || '',
        contact: msg.contact || '',
        content: msg.content,
        sender_id: msg.senderId || ''
      }).select();
      if (res.error) throw res.error;
      return { ok: true, message: rowToMsg(res.data[0]) };
    } catch (e) {
      console.error('[api] sendMessage failed', e);
      return { ok: false, error: e.message || '未知错误' };
    }
  };

  /** 当前身份：已登录用账号 ID，否则回退到本机设备 ID */
  LF.api.ownerId = function () {
    if (window.LF && LF.auth && LF.auth.userId) {
      var uid = LF.auth.userId();
      if (uid) return uid;
    }
    var k = 'lf_owner_id';
    var id = localStorage.getItem(k);
    if (!id) {
      id = 'u_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem(k, id);
    }
    return id;
  };

  /**
   * 登录后「收养」本机匿名发布的记录：
   * 把 owner_id / sender_id 还停在本机设备 ID 上的数据，迁到当前账号名下，
   * 这样之前没登录时发的失物、留言都能在「我的发布」和信箱里继续操作。
   * -> Promise<number> 迁移的物品条数（0 表示没有需要迁移的）
   */
  LF.api.adoptLocalItems = async function () {
    var uid = (window.LF && LF.auth && LF.auth.userId && LF.auth.userId()) || null;
    if (!uid) return 0;
    var localId = localStorage.getItem('lf_owner_id');
    if (!localId || localId === uid) return 0;

    try {
      var db = getCloud().database;
      var found = await db.from(LF.config.table).select('id').eq('owner_id', localId).limit(1000);
      if (found.error) throw found.error;
      var ids = (found.data || []).map(function (r) { return r.id; });

      if (ids.length) {
        var upd = await db.from(LF.config.table).update({ owner_id: uid }).eq('owner_id', localId);
        if (upd.error) throw upd.error;
      }
      // 匿名时发出的留言也一并认领，否则信箱「发件」里看不到
      await db.from(LF.config.messageTable).update({ sender_id: uid }).eq('sender_id', localId);

      var cache = loadCache().map(function (x) {
        return x.ownerId === localId ? Object.assign({}, x, { ownerId: uid }) : x;
      });
      saveCache(cache);
      localStorage.removeItem('lf_owner_id');   // 迁移过就不再复用这个身份
      return ids.length;
    } catch (e) {
      console.error('[api] adoptLocalItems failed', e);
      return 0;
    }
  };

  /** 默认实现，ui.js 加载后会覆盖成真正的状态条渲染 */
  LF.api.setStatus = function (text, ok) {
    var el = document.getElementById('cloud-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'sync-flag ' + (ok ? 'cloud-ok' : 'cloud-no');
  };
})();
