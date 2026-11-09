/**
 * assets/api.js —— 数据层（A 拥有）
 * 对外契约（B/C 只调这些，不要直接碰 cloud 对象）：
 *   LF.api.listItems()                -> Promise<Item[]>
 *   LF.api.searchItems(q, limit)      -> Promise<{ok, rows?, code?, error?}>  文字检索（共享 SQL 函数，p_keywords 固定 []）
 *   LF.api.createItem(item)           -> Promise<{ok:boolean, id?:number, error?:string}>
 *   LF.api.deleteItem(id)             -> Promise<{ok:boolean, error?:string}>
 *   LF.api.updateItem(id, patch)      -> Promise<{ok:boolean, error?:string}>
 *   LF.api.ownerId()                  -> string  本浏览器固定 ID（认领归属用）
 *   LF.api.setStatus(text, ok)        -> void    右上角连接状态（由 ui.js 实现渲染）
 *
 * Item 结构：
 *   { id, title, location, image, colorFeature,
 *     aiDesc, aiTags, status, postType, ownerId, pickupLocation, claimAt, time, createdAt }
 *   ⚠️ v1.13.0 起浏览器**不再持有 detail / location / ai_desc / ai_tags**：
 *   这四列在库里对 anon / authenticated 已收回 SELECT（见
 *   db/migrations/2026-11-07_harden_public_columns.sql），本文件的查询也
 *   显式不选它们。detail 只在服务端（阿寻按编号查）参与核验；
 *   上面 Item 结构里保留同名字段只是为了让老调用方读到空值而不是 undefined。
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

  /* 缓存换 key：v1 时代缓存里是**整条记录**（含 detail / location / ai_desc），
     那些内容已经落在用过网页的浏览器里。新版一律不再写入隐私列，旧 key 直接丢弃
     （不做迁移，迁移就等于把隐私数据继续留在本机）。 */
  var CACHE_KEY = 'lost_found_wbcloud_v2';
  var LEGACY_CACHE_KEYS = ['lost_found_wbcloud_v1'];

  /* 隐私列：即使服务端/缓存里混进来，也在进入内存前抹掉 */
  var HIDDEN_FIELDS = ['detail', 'location', 'aiDesc', 'aiTags'];

  function stripHidden(item) {
    if (!item || typeof item !== 'object') return item;
    var out = {};
    for (var k in item) {
      if (Object.prototype.hasOwnProperty.call(item, k) && HIDDEN_FIELDS.indexOf(k) < 0) out[k] = item[k];
    }
    return out;
  }

  function purgeLegacyCache() {
    for (var i = 0; i < LEGACY_CACHE_KEYS.length; i++) {
      try { localStorage.removeItem(LEGACY_CACHE_KEYS[i]); } catch (e) { /* 无痕模式忽略 */ }
    }
  }
  purgeLegacyCache();

  function loadCache() {
    try {
      var arr = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]');
      return Array.isArray(arr) ? arr.map(stripHidden) : [];
    } catch (e) { return []; }
  }

  function saveCache(items) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(items.map(stripHidden))); }
    catch (e) { /* 缓存失败不影响主流程 */ }
  }

  function rowToItem(r) {
    return {
      id: r.id,
      title: r.title || '',
      // detail / location / ai_desc / ai_tags 故意不映射：浏览器不该持有它们
      image: r.image || null,
      colorFeature: r.color_feature || null,
      notice: r.notice || '',
      category: r.category || '',
      colorTone: r.color_tone || '',
      status: r.status || 'open',
      postType: r.post_type || 'lost',
      ownerId: r.owner_id || '',
      pickupLocation: r.pickup_location || '',
      area: r.area || null,          // 七区枚举（地图用，粗粒度公开字段，见 zones.js）
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

  /* 显式列出字段而不是偷懒用 '*'：两个原因 ——
     1) pickup_location 是后加的列，明确列出来才能保证广场一定拿到寄存点；
     2) 2026-11-07 起 detail / location / ai_desc / ai_tags 对 anon 已撤 SELECT，
        select('*') 会直接 403。这份清单必须与
        db/migrations/2026-11-07_harden_public_columns.sql 的授权列表逐字一致。 */
  var PUBLIC_COLS = 'id,title,image,color_feature,notice,' +
    'category,color_tone,status,post_type,owner_id,pickup_location,claim_at,pub_time,created_at,' +
    'area';   // 2026-11-09 地图模块：area = 七区枚举，授权见 db/migrations/2026-11-09_map_area.sql

  /** 拉取全部物品（云端优先，失败回退本地缓存） */
  LF.api.listItems = async function () {
    try {
      var res = await getCloud().database.from(LF.config.table)
        .select(PUBLIC_COLS)
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
        .select(PUBLIC_COLS);          // 不能返回 detail：anon 对该列没有 SELECT
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
   *
   * ⚠️ 为什么 update 后面还要 `.select('id')`：
   *   PostgREST 的 UPDATE 在「RLS 把行过滤掉了」时返回 **204 + 空结果，没有 error**。
   *   只看 error 会把「一行都没改」当成成功——2026-11-07 验收时就真出现过：库里
   *   缺 UPDATE 策略，网页提示「已绑到你账号」，实际 owner_id 还是空的。
   *   所以必须把返回行数当成功判据：0 行 = 没写进去 = 失败。
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
      var res = await getCloud().database.from(LF.config.table).update(row).eq('id', id).select('id');
      if (res.error) throw res.error;
      if (!res.data || !res.data.length) {
        return {
          ok: false,
          code: 'not_written',
          error: '云端没有写入这条记录（可能没有权限，或记录已被删除），刷新后再试'
        };
      }
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
      var res = await getCloud().database.from(LF.config.table).select(PUBLIC_COLS).eq('id', id).limit(1);
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
      var cur = await db.from(LF.config.table).select(PUBLIC_COLS).eq('id', id).limit(1);
      if (cur.error) throw cur.error;
      var row = (cur.data || [])[0];
      if (!row) return { ok: false, code: 'notfound', error: '没有编号为 LF-' + id + ' 的记录' };
      if (row.owner_id) {
        if (row.owner_id === me) return { ok: true, already: true, item: rowToItem(row) };
        return { ok: false, code: 'taken', error: '这条记录已经绑到别的账号了' };
      }
      var upd = await db.from(LF.config.table).update({ owner_id: me }).eq('id', id).select('id');
      if (upd.error) throw upd.error;
      // 返回 0 行 = 没写进去（RLS 过滤 / 无 UPDATE 权限）。别把「没改动」报成绑定成功。
      if (!upd.data || !upd.data.length) {
        return {
          ok: false,
          code: 'not_written',
          error: '云端没有写入归属（可能没有权限），刷新后再试一次'
        };
      }
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

  /**
   * 寄存点列表（地图图层 + 广场「📍 寄存点」视图用）。
   * zone = 七区枚举（db/migrations/2026-11-09_map_area.sql）；非空的画上地图，
   * 空 zone 的行（如一食堂/图书馆这类老登记点）只进列表、不上图。
   */
  LF.api.listLocations = async function () {
    try {
      var res = await getCloud().database.from('locations')
        .select('id,name,address,open_hours,zone')
        .order('id', { ascending: true });
      if (res.error) throw res.error;
      return res.data || [];
    } catch (e) {
      console.error('[api] listLocations failed', e);
      return [];
    }
  };

  /* ================= 文字检索：与阿寻共用同一个 SQL 函数 =================
   *
   * 算法已经搬到库里（db/migrations/2026-11-07_lf_search_text_v1.sql），
   * 前端不再保留 search.js 那套本地打分：同义词扩展、2-gram、Dice、加分、
   * 排序、分级全部由 lf_search_text_v1 算，网页只传参 + 渲染。
   *
   * 通道：WorkBuddy Cloud SDK 的 database.rpc(name, params)
   *       → POST {endpoint}/.cloud/database/rest/rpc/<name>，参数走 JSON body。
   *       这条路已经实测过：网关是 PostgREST，函数不存在时返回 404 + PGRST202，
   *       说明 rpc 路由是通的，只要库里建了函数并 GRANT EXECUTE 就能调。
   *
   * 前置条件：库里必须先执行上面那份迁移。没执行时函数不存在，这里会返回
   *           code='rpc_missing'，**不会**退回本地打分——静默降级会让人以为
   *           算法在跑，其实跑的是另一套。
   */
  function rowToSearchHit(r) {
    return {
      item: rowToItem(r),
      score: Number(r.score) || 0,
      level: r.level || 'low',
      label: r.label || '',
      rank: Number(r.rank) || 0,
      algorithmVersion: r.algorithm_version || ''
    };
  }

  /**
   * 文字检索
   * @param {string} query    用户原话（或图片读出的「类别 + 主色」）
   * @param {number} [limit=20]
   * -> Promise<{ok:boolean, rows?:Array<{item,score,level,label,rank,algorithmVersion}>, code?:string, error?:string}>
   *
   * **输入契约（v1，两端统一）**：
   *   - `p_query` 只做 `trim`，不改写：不转小写、不拆词、不扩同义词；
   *   - `p_keywords` **固定传 `[]`**。同义词只由 SQL 内置字典（lf_expand_v1）处理，
   *     前端和智能体都不再各扩一套 —— 两边扩的词不一样，同一句输入就会得到不同结果。
   *     函数签名保留 `p_keywords`，只为离线对照测试和以后版本使用。
   *
   * 失败一律 `ok:false` + `code`，**绝不退化成 `rows: []`**。
   * 这一条不是洁癖：调用方看到空数组只会说「没有匹配」，而真实的失败原因
   * （函数没部署 / 没权限 / 网关 401 / 网络断 / 返回体不是数组）会被这句话盖掉，
   * 用户于是以为「库里真没有」，把找回线索判断错。
   */
  LF.api.searchItems = async function (query, limit) {
    // 0) 客户端初始化失败（配置缺失、SDK 没加载、createWorkBuddyCloud 抛错）
    //    也要归到「失败」，不能因为拿不到 db 就当成没搜到。
    var db;
    try {
      var cloud = getCloud();
      db = cloud && cloud.database;
    } catch (e) {
      console.error('[api] searchItems: cloud client init failed', e);
      return {
        ok: false,
        code: 'client_init_failed',
        error: '云客户端初始化失败：' + ((e && (e.message || e)) || '未知错误')
      };
    }

    if (!db || typeof db.rpc !== 'function') {
      return { ok: false, code: 'rpc_unsupported', error: '当前云 SDK 没有 rpc 能力，无法调用共享检索函数' };
    }

    // limit 兜底：0 / 负数 / NaN 会让函数返回 0 行，那看起来就像「没有匹配」
    var lim = Number(limit);
    if (!isFinite(lim) || lim < 1) lim = 20;
    if (lim > 200) lim = 200;
    lim = Math.floor(lim);

    var res;
    try {
      res = await db.rpc('lf_search_text_v1', {
        // 只 trim，不改写原话；空串原样传（函数会返回 0 行，由调用方决定怎么说）
        p_query: String(query == null ? '' : query).trim(),
        // 固定空数组：同义词交给 SQL 字典，前端不扩词（见上方输入契约）
        p_keywords: [],
        p_limit: lim
      });
    } catch (e) {
      console.error('[api] searchItems: rpc threw', e);
      return failFromError(e, '调用共享检索函数失败');
    }

    if (res && res.error) return failFromError(res.error, '共享检索函数返回错误');

    // 1) 返回体形状校验：没有 data、或 data 不是数组 —— 都是失败，不是空结果
    if (!res || !Array.isArray(res.data)) {
      var got = res === undefined ? 'undefined'
        : res === null ? 'null'
        : (typeof res.data === 'undefined' ? '无 data 字段' : 'data 不是数组（' + typeof res.data + '）');
      return {
        ok: false,
        code: 'rpc_bad_response',
        error: '共享检索函数返回体异常：' + got + '。这不代表「没有匹配」'
      };
    }

    return { ok: true, rows: res.data.map(rowToSearchHit) };
  };

  /** 把 rpc 抛出的错误分类：函数不存在 / 其他失败，两者都不等于「没有匹配」 */
  function failFromError(e, prefix) {
    var codeText = (e && e.code) || '';
    var msg = (e && (e.message || e.details || e.hint)) || '';
    if (!msg) {
      try {
        msg = e && typeof e === 'object' ? JSON.stringify(e) : String(e || '');
      } catch (err) { msg = String(e); }
    }
    if (!msg || msg === '{}') msg = '未知错误';
    // 网关给的是 DATABASE_PGRST202（带命名空间前缀），所以用包含匹配而不是全等
    var missing = /PGRST202|Could not find the function/i.test(codeText + ' ' + msg);
    return {
      ok: false,
      code: missing ? 'rpc_missing' : 'rpc_failed',
      error: prefix + '：' + msg
    };
  }

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
        var upd = await db.from(LF.config.table).update({ owner_id: uid }).eq('owner_id', localId).select('id');
        if (upd.error) throw upd.error;
        var moved = (upd.data || []).length;
        // 一条都没改：说明被 RLS / 权限挡住了。这时候既不能报「已迁移 N 条」，
        // 也不能删掉本机设备 ID（删了就再也找不回这批记录）。
        if (!moved) {
          console.error('[api] adoptLocalItems: 0 条被更新，保留本机设备 ID 以便重试');
          return 0;
        }
        ids = upd.data.map(function (r) { return r.id; });
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
