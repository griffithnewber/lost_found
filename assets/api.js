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
 *     aiDesc, aiTags, status, postType, ownerId, pickupLocation, claimAt, time, createdAt }
 *   detail / location 为隐藏字段，仅核验流程使用；
 *   pickupLocation（寄存点）是公开字段，广场卡片会显示「可到某处认领」。
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
      pickupLocation: r.pickup_location || '',
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
      pickup_location: item.pickupLocation || '',
      pub_time: item.time || new Date().toLocaleString('zh-CN')
    };
    return row;
  }

  LF.api.getCloud = getCloud;
  LF.api.loadCache = loadCache;

  /* 显式列出字段而不是偷懒用 '*'：pickup_location 是后加的列，
     明确列出来才能保证广场一定拿到寄存点，不会因为云端默认列集不同而静默丢字段。 */
  var ITEM_COLS = 'id,title,detail,location,image,color_feature,ai_desc,ai_tags,notice,' +
    'category,color_tone,status,post_type,owner_id,pickup_location,claim_at,pub_time,created_at';

  /** 拉取全部物品（云端优先，失败回退本地缓存） */
  LF.api.listItems = async function () {
    try {
      var res = await getCloud().database.from(LF.config.table)
        .select(ITEM_COLS)
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
    if ('pickupLocation' in patch) row.pickup_location = patch.pickupLocation;
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

  /** 按 id 取单条（编号绑定、直达链接用）-> Promise<Item|null> */
  LF.api.findItemById = async function (id) {
    try {
      var res = await getCloud().database.from(LF.config.table).select('*').eq('id', id).limit(1);
      if (res.error) throw res.error;
      var row = (res.data || [])[0];
      return row ? rowToItem(row) : null;
    } catch (e) {
      console.error('[api] findItemById failed', e);
      return null;
    }
  };

  /**
   * 把一条「无归属」的记录绑到当前账号。
   *
   * 为什么需要：智能体登记时不知道用户是谁（对话里没有登录身份），写进去的记录
   * owner_id 是空的。结果是——补图不算自己发的、「我的发布」看不到、更致命的是
   * 别人留言后信箱里永远收不到，整条闭环断在最后一步。
   * 用户在网页输入编号（LF-18 / 18）或点直达链接即可当场绑回。
   *
   * 规则：只允许绑定 owner_id 为空的记录。已有归属的直接拒绝，防止抢绑别人的帖子。
   * -> Promise<{ok, code?: 'notfound'|'taken'|'nologin', already?: boolean, item?}>
   */
  LF.api.bindItemOwner = async function (id, ownerId) {
    var me = ownerId || (window.LF && LF.auth && LF.auth.userId && LF.auth.userId()) || null;
    if (!me) return { ok: false, code: 'nologin', error: '请先登录再绑定' };
    try {
      var db = getCloud().database;
      var cur = await db.from(LF.config.table).select('*').eq('id', id).limit(1);
      if (cur.error) throw cur.error;
      var row = (cur.data || [])[0];
      if (!row) return { ok: false, code: 'notfound', error: '没有编号为 LF-' + id + ' 的记录' };
      if (row.owner_id) {
        if (row.owner_id === me) return { ok: true, already: true, item: rowToItem(row) };
        return { ok: false, code: 'taken', error: '这条记录已经绑到别的账号了' };
      }
      var upd = await db.from(LF.config.table).update({ owner_id: me }).eq('id', id);
      if (upd.error) throw upd.error;
      var item = rowToItem(Object.assign({}, row, { owner_id: me }));
      saveCache(loadCache().map(function (x) {
        return x.id === id ? Object.assign({}, x, { ownerId: me }) : x;
      }));
      return { ok: true, item: item };
    } catch (e) {
      console.error('[api] bindItemOwner failed', e);
      return { ok: false, code: 'error', error: e.message || '未知错误' };
    }
  };

  /**
   * 广场可见物品：排除已找回（status = 'returned'）的记录。
   * claimed（已有人认领）仍然保留——阿寻给的 #item-<id> 深链经常指向刚认领的记录，
   * 过滤掉会让链接跳空；广场上用徽章区分状态就够了。
   */
  LF.api.listPublicItems = async function () {
    var items = await LF.api.listItems();
    return items.filter(function (x) { return x.status !== 'returned'; });
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
