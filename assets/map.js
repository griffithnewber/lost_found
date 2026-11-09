/**
 * assets/map.js —— 校园地图（广场的子模块，B 拥有）
 *
 * 底图：腾讯地图 GL JS（合规要求：国内地图仅允许腾讯/高德/百度/天地图）。
 * SDK 在 index.html 引入，key 为站长自备 Key。
 * 坐标：GCJ-02，见 assets/zones.js。
 *
 * 覆盖物按官方 DOMOverlay 生命周期实现（onInit 存参 → createDOM 建元素 →
 * updateDOM 用 map.projectToContainer 自己定位 → onDestroy 清理）。
 * 注意：定位必须自己在 updateDOM 里算，SDK 不会替你摆位置。
 *
 * 两个图层：
 *   寄存点层（locations 表 zone 非空的行）：📍 画在区中心锚点 + 名称标签；
 *   物品层（lost_items.area 对应的物品 emoji）：从锚点向外环形散开（米级
 *   半径，见 zones.spread）——寄存点居中、物品绕圈，两层天然不重叠。
 * area 为空的记录不上图（用户定稿：没有真实位置不占假位置），
 * 数量提示在地图副标题。寄存点可点击，弹信息卡（名称/地址/开放时间）。
 *
 * 交互：电脑 Ctrl+滚轮缩放（capture 阶段拦截 SDK 普通滚轮，页面照常滚）、
 * 手机双指捏合/拖拽/双击由 SDK 原生支持、复位按钮回初始视野。
 *
 * 联动：点物品标记 → 'lf:focus-item'（square.js 滚到卡片并高亮）；
 *       收到 'lf:map-focus' → 标记脉冲 + 平移到视野中心。
 *
 * 对外接口：
 *   LF.map.init(container) / setItems(rows) / setLocations(locs) / setShowPickup(bool)
 */
(function () {
  'use strict';

  window.LF = window.LF || {};
  LF.map = {};

  var container = null;
  var uiLayer = null;               // 控件/信息卡的宿主（地图容器的兄弟层 .map-ui）
  var map = null;                   // TMap.Map 实例
  var itemOverlays = {};            // id -> overlay（物品）
  var locOverlays = [];             // 寄存点 overlays
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

  /* ---------- 覆盖物基类：官方 DOMOverlay 生命周期 ---------- */
  /* options: { map, position, cls, html, title, anchor('center'|'bottom'), onClick } */
  function LfOverlay(options) {
    TMap.DOMOverlay.call(this, options);
  }
  LfOverlay.prototype = new TMap.DOMOverlay();
  LfOverlay.prototype.onInit = function (options) {
    this.position = options.position;
    this._cls = options.cls || '';
    this._html = options.html || '';
    this._title = options.title || '';
    this._anchor = options.anchor || 'center';
    this._onClick = options.onClick || null;
  };
  LfOverlay.prototype.createDOM = function () {
    var self = this;
    var d = document.createElement('div');
    d.style.cssText = 'position:absolute;top:0;left:0;';
    d.className = this._cls;
    if (this._title) d.title = this._title;
    d.innerHTML = this._html;
    if (this._onClick) {
      d.addEventListener('click', function (e) {
        e.stopPropagation();
        self._onClick(e);
      });
    }
    return d;
  };
  LfOverlay.prototype.updateDOM = function () {
    if (!this.map || !this.dom) return;
    var pixel = this.map.projectToContainer(this.position);
    var left = pixel.getX() - this.dom.clientWidth / 2;
    var top = pixel.getY() - this.dom.clientHeight / 2;
    if (this._anchor === 'bottom') top = pixel.getY() - this.dom.clientHeight;
    this.dom.style.left = left + 'px';
    this.dom.style.top = top + 'px';
  };
  LfOverlay.prototype.onDestroy = function () {
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
    hideLocPopup();
    if (!map || !ready) return;

    if (showPickup) {
      locations.filter(function (l) { return l.zone && LF.zones.get(l.zone); })
        .forEach(function (l) {
          var z = LF.zones.get(l.zone);
          locOverlays.push(new LfOverlay({
            map: map,
            position: latLng(z),
            cls: 'pickup-mk',
            anchor: 'bottom',
            html: '<div class="pickup-pin">📍</div>' +
                  '<div class="pickup-name">' + z.label + '</div>',
            title: l.name + '（' + (l.address || '') + ' ' + (l.open_hours || '') + '）',
            onClick: function () { showLocPopup(l, z); }
          }));
        });
    }
  }

  /* 寄存点信息卡（点击寄存点弹出；同一张卡复用，点 × 收起）
     卡片挂在 .map-ui 兄弟层——挂在地图容器内部会被 SDK 的事件层吞掉点击 */
  function showLocPopup(l, z) {
    var pop = uiLayer.querySelector('.loc-popup');
    if (!pop) {
      pop = document.createElement('div');
      pop.className = 'loc-popup';
      uiLayer.appendChild(pop);
    }
    pop.innerHTML =
      '<button type="button" class="loc-close" aria-label="关闭">✕</button>' +
      '<div class="loc-title">📍 ' + LF.ui.esc(l.name || z.label) + '</div>' +
      '<div class="loc-row">' + LF.ui.esc(z.label) + ' · 区域寄存点</div>' +
      (l.address ? '<div class="loc-row">🏷️ ' + LF.ui.esc(l.address) + '</div>' : '') +
      (l.open_hours ? '<div class="loc-row">🕘 ' + LF.ui.esc(l.open_hours) + '</div>' : '') +
      '<div class="loc-tip">捡到东西交给这里保管，登记时选「放寄存点」即可</div>';
    pop.classList.add('show');
    pop.querySelector('.loc-close').addEventListener('click', function (e) {
      e.stopPropagation();
      hideLocPopup();
    });
  }
  function hideLocPopup() {
    if (!uiLayer) return;
    var pop = uiLayer.querySelector('.loc-popup');
    if (pop) pop.classList.remove('show');
  }

  function drawItems() {
    Object.keys(itemOverlays).forEach(function (k) {
      destroyOverlay(itemOverlays[k]);
      delete itemOverlays[k];
    });
    if (!map || !ready) return;

    // 按区分组，同一区的物品从锚点向外环形散开；area 为空的**不上图**（用户定稿：
    // 没有真实位置不占假位置），数量进副标题提示
    var unlocated = 0;
    var groups = {};
    items.forEach(function (it) {
      if (it.area && LF.zones.get(it.area)) {
        (groups[it.area] = groups[it.area] || []).push(it);
      } else {
        unlocated++;
      }
    });
    var note = document.getElementById('map-unlocated');
    if (note) {
      note.textContent = unlocated > 0
        ? unlocated + ' 条未标注区域不上图'
        : '';
    }

    var sp = LF.zones.spread || { ring: 38, gap: 12, maxRing: 3 };
    Object.keys(groups).forEach(function (code) {
      var anchor = LF.zones.get(code);
      if (!anchor) return;
      var rows = groups[code];
      var n = rows.length;
      rows.forEach(function (it, i) {
        var ang = (-90 + i * (360 / Math.max(n, 1))) * Math.PI / 180;
        var ringIdx = n > 8 ? Math.min(Math.floor(i / n), sp.maxRing - 1) : 0;
        var r = (sp.ring + ringIdx * sp.gap);
        var d = metersToDelta(anchor.lat, r * Math.cos(ang), r * Math.sin(ang));
        var isFound = it.postType === 'found';
        itemOverlays[it.id] = new LfOverlay({
          map: map,
          position: new TMap.LatLng(anchor.lat + d.lat, anchor.lng + d.lng),
          cls: 'item-mk ' + (isFound ? 'mk-found' : 'mk-lost'),
          html: emojiOf(it),
          title: 'LF-' + it.id + ' ' + (it.title || '') + (isFound ? '（待认领）' : '（失者寻物）'),
          onClick: function () {
            document.dispatchEvent(new CustomEvent('lf:focus-item', { detail: { id: it.id } }));
          }
        });
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
        // 放行给地图：阻止页面/浏览器缩放，手动按滚轮方向缩放
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
        showControl: false,          // 关掉腾讯默认控件（罗盘/缩放叠在我们的按钮上），只用自绘按钮
        draggable: true,
        doubleClickZoom: true
      });
    } catch (e) {
      showKeyHint();
      return;
    }
    ready = true;

    // 控件宿主：优先用 index.html 预置的 .map-ui 兄弟层（不被 SDK 吞点击）
    uiLayer = container.parentNode && container.parentNode.querySelector('.map-ui');
    if (!uiLayer) {
      uiLayer = document.createElement('div');
      uiLayer.className = 'map-ui';
      (container.parentNode || container).appendChild(uiLayer);
    }

    // 覆盖按钮：寄存点图层开关 + 复位 + 手势提示
    var bar = document.createElement('div');
    bar.innerHTML =
      '<button type="button" class="map-btn map-btn-pickup active" id="map-pickup-toggle" title="显示/隐藏寄存点">📍 寄存点</button>' +
      '<button type="button" class="map-btn map-btn-reset" id="map-reset" title="回到全图">⤢ 复位</button>' +
      '<div class="map-hint">电脑 Ctrl+滚轮缩放 · 手机双指捏合 · 拖拽平移 · 点标记看记录</div>';
    uiLayer.appendChild(bar);

    uiLayer.querySelector('#map-pickup-toggle').addEventListener('click', function () {
      showPickup = !showPickup;
      this.classList.toggle('active', showPickup);
      drawZones();
    });
    uiLayer.querySelector('#map-reset').addEventListener('click', function () {
      var home = latLng(LF.zones.center);
      try {
        if (typeof map.easeTo === 'function') {
          map.easeTo({ center: home, zoom: LF.zones.zoom, duration: 400 });
        } else {
          throw new Error('no easeTo');
        }
      } catch (e) {
        try { map.setCenter(home); map.setZoom(LF.zones.zoom); } catch (e2) {}
      }
    });

    bindGestures();
    document.addEventListener('lf:map-focus', function (e) {
      focusItem(e.detail && e.detail.id);
    });
    drawZones();
    if (items.length) drawItems();   // init 晚于 setItems 到达时补画
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
    var btn = uiLayer && uiLayer.querySelector('#map-pickup-toggle');
    if (btn) btn.classList.toggle('active', showPickup);
    drawZones();
  };
})();
