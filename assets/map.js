/**
 * assets/map.js —— 校园地图（广场的子模块，B 拥有）
 *
 * 底图：腾讯地图 GL JS（合规要求：国内地图仅允许腾讯/高德/百度/天地图，
 * 不用 OpenStreetMap 等）。SDK 在 index.html 引入，key 占位符需站长替换。
 * 坐标：GCJ-02，见 assets/zones.js。
 *
 * 两个图层：
 *   寄存点层（locations 表 zone 非空的行）：📍 画在区中心锚点 + 名称标签；
 *   物品层（lost_items.area 对应的物品 emoji）：从锚点向外环形散开（米级
 *   半径，见 zones.spread）——寄存点居中、物品绕圈，两层天然不重叠。
 * area 为空的老记录画进「未定位」收纳点，不丢数据。
 *
 * 交互：
 *   电脑：Ctrl+滚轮缩放（普通滚轮只滚页面，不劫持）、双击放大、拖拽平移
 *   手机：双指捏合缩放、单指拖拽（腾讯 SDK 原生支持）
 *   复位按钮回到初始视野
 *
 * 联动（与广场列表双向）：
 *   点物品标记 → 广播 'lf:focus-item'（square.js 滚到卡片并高亮）
 *   收到 'lf:map-focus' → 对应标记脉冲 + 平移到视野中心
 *
 * 对外接口（与旧 SVG 版完全一致）：
 *   LF.map.init(container)                  挂载（DOMContentLoaded 一次）
 *   LF.map.setItems(rows)                   广场过滤后的物品（每次 draw 调）
 *   LF.map.setLocations(locs)               locations 表数据（拉一次）
 *   LF.map.setShowPickup(bool)              寄存点图层开关
 */
(function () {
  'use strict';

  window.LF = window.LF || {};
  LF.map = {};

  var container = null;
  var map = null;                   // TMap.Map 实例
  var itemOverlays = {};            // id -> overlay（物品）
  var locOverlays = [];             // 寄存点 overlays
  var pocketOverlay = null;         // 「未定位」收纳点
  var items = [];
  var locations = [];
  var showPickup = true;
  var ready = false;                // TMap 是否成功加载

  /* ---------- 小工具 ---------- */
  function emojiOf(it) {
    var cat = (LF.config.categories || []).filter(function (c) { return c.key === it.category; })[0];
    return (cat && cat.emoji) || '📦';
  }
  function latLng(z) { return new TMap.LatLng(z.lat, z.lng); }

  /** 米偏移 → 经纬度偏移（用于环形散开） */
  function metersToDelta(lat, dx, dy) {
    return {
      lat: dy / 111320,
      lng: dx / (111320 * Math.cos(lat * Math.PI / 180))
    };
  }

  /* ---------- 覆盖物：物品 emoji ---------- */
  function ItemOverlay(opts) {
    TMap.DOMOverlay.call(this, opts);
  }
  /* 优先走官方 DOMOverlay；SDK 没有该类时退化为不挂载（ready=false 已兜底） */
  ItemOverlay.prototype = Object.create(TMap.DOMOverlay.prototype);
  ItemOverlay.prototype.constructor = ItemOverlay;
  ItemOverlay.prototype.onInit = function (options) {
    var it = options.item;
    var isFound = it.postType === 'found';
    var self = this;
    this.dom = document.createElement('div');
    this.dom.className = 'item-mk ' + (isFound ? 'mk-found' : 'mk-lost');
    this.dom.title = 'LF-' + it.id + ' ' + (it.title || '') + (isFound ? '（待认领）' : '（失者寻物）');
    this.dom.textContent = emojiOf(it);
    this.dom.addEventListener('click', function (e) {
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent('lf:focus-item', { detail: { id: it.id } }));
    });
  };
  ItemOverlay.prototype.onDestroy = function () {
    if (this.dom && this.dom.parentNode) this.dom.parentNode.removeChild(this.dom);
    this.dom = null;
  };

  /* ---------- 覆盖物：寄存点 📍 ---------- */
  function PickupOverlay(opts) {
    TMap.DOMOverlay.call(this, opts);
  }
  PickupOverlay.prototype = Object.create(TMap.DOMOverlay.prototype);
  PickupOverlay.prototype.constructor = PickupOverlay;
  PickupOverlay.prototype.onInit = function (options) {
    var loc = options.loc;
    var z = options.zone;
    this.dom = document.createElement('div');
    this.dom.className = 'pickup-mk';
    this.dom.title = loc.name + '（' + (loc.address || '') + ' ' + (loc.open_hours || '') + '）';
    this.dom.innerHTML =
      '<div class="pickup-pin">📍</div>' +
      '<div class="pickup-name">' + z.label + '</div>';
  };
  PickupOverlay.prototype.onDestroy = function () {
    if (this.dom && this.dom.parentNode) this.dom.parentNode.removeChild(this.dom);
    this.dom = null;
  };

  /* ---------- 覆盖物：「未定位」收纳点 ---------- */
  function PocketOverlay(opts) {
    TMap.DOMOverlay.call(this, opts);
  }
  PocketOverlay.prototype = Object.create(TMap.DOMOverlay.prototype);
  PocketOverlay.prototype.constructor = PocketOverlay;
  PocketOverlay.prototype.onInit = function () {
    this.dom = document.createElement('div');
    this.dom.className = 'unknown-pocket';
    this.dom.textContent = '未定位';
    this.dom.title = '登记时没有说清区域的旧记录都收在这里';
  };
  PocketOverlay.prototype.onDestroy = function () {
    if (this.dom && this.dom.parentNode) this.dom.parentNode.removeChild(this.dom);
    this.dom = null;
  };

  function destroyOverlay(o) {
    if (!o) return;
    try { o.destroy(); } catch (e) { try { o.setMap(null); } catch (e2) {} }
  }

  /* ---------- 图层渲染 ---------- */
  function drawZones() {
    locOverlays.forEach(destroyOverlay);
    locOverlays = [];
    if (!map || !ready) return;
    if (showPickup) {
      locations.filter(function (l) { return l.zone && LF.zones.get(l.zone); })
        .forEach(function (l) {
          locOverlays.push(new PickupOverlay({
            map: map,
            position: latLng(LF.zones.get(l.zone)),
            loc: l,
            zone: LF.zones.get(l.zone)
          }));
        });
    }
  }

  function drawItems() {
    Object.keys(itemOverlays).forEach(function (k) {
      destroyOverlay(itemOverlays[k]);
      delete itemOverlays[k];
    });
    if (!map || !ready) return;

    // 按区分组，同一区的物品从锚点向外环形散开；空 area 进「未定位」
    var groups = {};
    items.forEach(function (it) {
      var key = (it.area && LF.zones.get(it.area)) ? it.area : '__unknown';
      (groups[key] = groups[key] || []).push(it);
    });

    var sp = LF.zones.spread || { ring: 38, gap: 12, maxRing: 3 };
    Object.keys(groups).forEach(function (code) {
      var anchor = code === '__unknown' ? LF.zones.unknownPocket : LF.zones.get(code);
      var rows = groups[code];
      var n = rows.length;
      rows.forEach(function (it, i) {
        var ang = (-90 + i * (360 / Math.max(n, 1))) * Math.PI / 180;
        var ringIdx = n > 8 ? Math.min(Math.floor(i / n), sp.maxRing - 1) : 0;
        var r = (sp.ring + ringIdx * sp.gap);
        var d = metersToDelta(anchor.lat, r * Math.cos(ang), r * Math.sin(ang));
        var pos = new TMap.LatLng(anchor.lat + d.lat, anchor.lng + d.lng);
        var o = new ItemOverlay({ map: map, position: pos, item: it });
        itemOverlays[it.id] = o;
      });
    });
  }

  /* ---------- 联动：广场卡片 → 地图标记脉冲 ---------- */
  function focusItem(id) {
    var o = itemOverlays[id];
    if (!o || !map) return;   // 被过滤掉或未定位区外，静默
    try {
      map.easeTo({ center: o.position, zoom: Math.max(map.getZoom(), 17), duration: 500 });
    } catch (e) {
      try { map.setCenter(o.position); map.setZoom(17); } catch (e2) {}
    }
    if (o.dom) {
      o.dom.classList.add('pulse');
      setTimeout(function () { o.dom && o.dom.classList.remove('pulse'); }, 2200);
    }
  }

  /* ---------- 手势：只放开 Ctrl+滚轮，普通滚轮还给页面 ---------- */
  function bindGestures() {
    container.addEventListener('wheel', function (e) {
      if (!ready) return;
      if (e.ctrlKey || e.metaKey) {
        // 放行给地图：阻止页面/浏览器缩放，交给 SDK 滚轮缩放
        e.preventDefault();
        e.stopPropagation();
        try {
          map.setZoom(map.getZoom() + (e.deltaY < 0 ? 0.5 : -0.5));
        } catch (err) {}
      } else {
        // 普通滚轮 = 页面滚动：拦下事件不让 SDK 抢，但不 preventDefault
        e.stopPropagation();
      }
    }, { capture: true, passive: false });
  }

  /* ---------- key 缺失 / SDK 加载失败的兜底 ---------- */
  function showKeyHint() {
    ready = false;
    container.innerHTML =
      '<div class="map-need-key">' +
      '<div class="nk-emoji">🗺️</div>' +
      '<div class="nk-title">真实地图还没有配置 Key</div>' +
      '<div class="nk-text">到 <b>lbs.qq.com</b>（腾讯位置服务）控制台 → 应用管理 → 创建应用 → 添加 Key' +
      '（勾选「JavascriptAPI GL」），然后把 index.html 里 gljs 链接的 key= 占位符换成你的 Key，' +
      '并在 Key 设置里把域名白名单加上本站域名。</div>' +
      '</div>';
  }

  /* ---------- 挂载 ---------- */
  LF.map.init = function (box) {
    if (!box || !LF.zones) return;
    container = box;

    if (typeof TMap === 'undefined') { showKeyHint(); return; }

    try {
      map = new TMap.Map(container, {
        center: latLng(LF.zones.center),
        zoom: LF.zones.zoom,
        minZoom: LF.zones.minZoom,
        maxZoom: LF.zones.maxZoom,
        viewMode: '2D',
        showControl: true,
        draggable: true,
        doubleClickZoom: true
      });
    } catch (e) {
      showKeyHint();
      return;
    }
    ready = true;

    // 覆盖按钮：寄存点图层开关 + 复位 + 手势提示
    var bar = document.createElement('div');
    bar.innerHTML =
      '<button type="button" class="map-btn map-btn-pickup active" id="map-pickup-toggle" title="显示/隐藏寄存点">📍 寄存点</button>' +
      '<button type="button" class="map-btn map-btn-reset" id="map-reset" title="回到全图">⤢ 复位</button>' +
      '<div class="map-hint">电脑 Ctrl+滚轮缩放 · 手机双指捏合 · 拖拽平移 · 点标记看记录</div>';
    container.appendChild(bar);

    container.querySelector('#map-pickup-toggle').addEventListener('click', function () {
      showPickup = !showPickup;
      this.classList.toggle('active', showPickup);
      drawZones();
    });
    container.querySelector('#map-reset').addEventListener('click', function () {
      try {
        map.easeTo({ center: latLng(LF.zones.center), zoom: LF.zones.zoom, duration: 400 });
      } catch (e) {
        try { map.setCenter(latLng(LF.zones.center)); map.setZoom(LF.zones.zoom); } catch (e2) {}
      }
    });

    bindGestures();
    document.addEventListener('lf:map-focus', function (e) {
      focusItem(e.detail && e.detail.id);
    });
    drawZones();
  };

  LF.map.setItems = function (rows) {
    items = rows || [];
    drawItems();
  };
  LF.map.setLocations = function (locs) {
    locations = locs || [];
    drawZones();
  };
  LF.map.setShowPickup = function (v) {
    showPickup = !!v;
    var btn = container && container.querySelector('#map-pickup-toggle');
    if (btn) btn.classList.toggle('active', showPickup);
    drawZones();
  };
})();
