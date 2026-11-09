/**
 * assets/map.js —— 校园地图（广场的子模块，B 拥有）
 *
 * 设计文档：docs/PLAN-MAP-MODULE.md。零外部依赖、零 key：
 * 底图是按 assets/zones.js 的七区坐标自动生成的 SVG 示意图——
 * 校准真实校区时只改 zones.js 的坐标，这里的图跟着变。
 *
 * 两个图层：
 *   寄存点层（zonesLayer）：locations 表 zone 非空的行，画在区中心锚点；
 *   物品层（itemsLayer）  ：lost_items.area 对应的物品 emoji，从锚点向外
 *                           环形散开——寄存点居中、物品绕圈，两层天然不重叠。
 * area 为空的老记录画进右下角「未定位」收纳点，不丢数据。
 *
 * 交互（对照 PLAN §5.4）：
 *   电脑：Ctrl+滚轮缩放（普通滚轮留给页面滚动，绝不劫持）、双击放大、拖拽平移
 *   手机：双指捏合缩放、单指拖拽（touch-action:none 只在地图容器上）
 *   复位按钮回到全图；缩放范围 1×–5×，平移钳制在地图范围内
 *
 * 联动（对照 PLAN §5.5）：
 *   点物品标记 → 广播 'lf:focus-item'（square.js 滚到卡片并高亮）
 *   收到 'lf:map-focus' → 对应标记脉冲 + 平移到视野中心
 *
 * 对外接口：
 *   LF.map.init(container)                  挂载（DOMContentLoaded 一次）
 *   LF.map.setItems(rows)                   广场过滤后的物品（每次 draw 调）
 *   LF.map.setLocations(locs)               locations 表数据（拉一次）
 *   LF.map.setShowPickup(bool)              寄存点图层开关
 */
(function () {
  'use strict';

  window.LF = window.LF || {};
  LF.map = {};

  var NS = 'http://www.w3.org/2000/svg';
  var W = 1000, H = 700;            // 与 zones.js 一致的逻辑画布
  var S_MIN = 1, S_MAX = 5;

  var container = null;
  var svg = null, world = null, zoneLayer = null, itemsLayer = null;
  var view = { s: 1, tx: 0, ty: 0 };
  var items = [];                   // 广场过滤后的物品（含 area 字段）
  var locations = [];               // locations 表（zone 非空的才画）
  var showPickup = true;

  /* ---------- 小工具 ---------- */
  function elNS(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs || {}) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function elHTML(html) {
    var d = document.createElement('div');
    d.innerHTML = html;
    return d.firstChild;
  }
  function emojiOf(it) {
    var cat = (LF.config.categories || []).filter(function (c) { return c.key === it.category; })[0];
    return (cat && cat.emoji) || '📦';
  }

  /* ---------- 视图变换 ---------- */
  function clampView() {
    var s = view.s;
    // 平移钳制：变换后的地图必须始终盖住视口（s=1 时恰好归零）
    view.tx = Math.min(0, Math.max(W - W * s, view.tx));
    view.ty = Math.min(0, Math.max(H - H * s, view.ty));
  }
  function applyView() {
    clampView();
    world.setAttribute('transform',
      'translate(' + view.tx + ',' + view.ty + ') scale(' + view.s + ')');
  }
  function resetView() { view = { s: 1, tx: 0, ty: 0 }; applyView(); }

  /** 客户端坐标 → 画布逻辑坐标（viewBox letterboxing 修正） */
  function toCanvas(cx, cy) {
    var r = svg.getBoundingClientRect();
    var k = Math.min(r.width / W, r.height / H);
    var offX = (r.width - W * k) / 2, offY = (r.height - H * k) / 2;
    return { x: (cx - r.left - offX) / k, y: (cy - r.top - offY) / k };
  }

  /** 以画布点 p 为中心缩放 factor 倍 */
  function zoomAt(p, factor) {
    var s2 = Math.min(S_MAX, Math.max(S_MIN, view.s * factor));
    if (s2 === view.s) return;
    // 保持 p 点在缩放前后指向同一世界坐标：p = (c - t)/s → t' = c - p*s'
    view.tx = p.x - (p.x - view.tx) * (s2 / view.s);
    view.ty = p.y - (p.y - view.ty) * (s2 / view.s);
    view.s = s2;
    applyView();
  }

  /* ---------- 底图（按 zones 配置自动生成） ---------- */
  function drawBase() {
    // 背景草坪底色
    elNS('rect', { x: 0, y: 0, width: W, height: H, rx: 18, fill: '#F4F8FC' }, world);

    // 主环路：一条贯穿七区之间的环线（装饰性，示意）
    elNS('path', {
      d: 'M 500 130 L 640 280 L 810 430 L 660 570 L 340 570 L 190 430 L 360 280 Z',
      fill: 'none', stroke: '#E3EBF7', 'stroke-width': 22, 'stroke-linejoin': 'round'
    }, world);
    // 中轴道路
    elNS('path', {
      d: 'M 190 430 L 500 380 L 810 430 M 360 280 L 500 380 L 640 280 M 500 130 L 500 380 M 340 570 L 500 560 L 660 570',
      fill: 'none', stroke: '#E9F0F9', 'stroke-width': 10, 'stroke-linejoin': 'round'
    }, world);
    // 中心湖（示意）
    elNS('ellipse', { cx: 505, cy: 395, rx: 78, ry: 52, fill: '#D9EAF8' }, world);
    elNS('text', { x: 505, y: 400, 'text-anchor': 'middle', 'font-size': 15, fill: '#9FB8D8' }, world)
      .textContent = '湖';

    // 各区建筑（形状按区类型，坐标全部来自 zones 配置）
    LF.zones.list.forEach(function (z) {
      drawZoneBuilding(z);
    });

    // 「未定位」收纳点的底座
    var u = LF.zones.unknownPocket;
    elNS('circle', { cx: u.x, cy: u.y, r: 26, fill: '#EFF3F8', stroke: '#D5DEEA', 'stroke-dasharray': '4 3' }, world);
    var ul = elNS('text', { x: u.x, y: u.y + 44, 'text-anchor': 'middle', 'font-size': 15, fill: '#8B99AD' }, world);
    ul.textContent = '未定位';
  }

  function drawZoneBuilding(z) {
    var g = elNS('g', {}, world);
    var labelColor = '#5F7495';
    if (z.code === 'east_playground' || z.code === 'west_playground') {
      // 操场：绿色场地 + 跑道椭圆
      elNS('rect', { x: z.x - 85, y: z.y - 55, width: 170, height: 110, rx: 55, fill: '#E7F5EA', stroke: '#CFE9D5' }, g);
      elNS('ellipse', { cx: z.x, cy: z.y, rx: 56, ry: 34, fill: 'none', stroke: '#BFE3C8', 'stroke-width': 4 }, g);
      elNS('rect', { x: z.x - 26, y: z.y - 16, width: 52, height: 32, rx: 6, fill: '#D9EFD9' }, g);
    } else if (z.code === 'gym') {
      // 体育馆：椭圆圆顶
      elNS('ellipse', { cx: z.x, cy: z.y, rx: 92, ry: 48, fill: '#EFE9FB', stroke: '#DDD2F0' }, g);
      elNS('ellipse', { cx: z.x, cy: z.y, rx: 52, ry: 26, fill: '#F7F3FE' }, g);
    } else if (z.code === 'east_dorm' || z.code === 'west_dorm') {
      // 宿舍：三排小楼
      for (var i = 0; i < 3; i++) {
        elNS('rect', { x: z.x - 88 + i * 62, y: z.y - 22, width: 50, height: 44, rx: 7, fill: '#E9F1FB', stroke: '#D3E2F4' }, g);
      }
    } else {
      // 教学楼群：一大一小两栋
      elNS('rect', { x: z.x - 96, y: z.y - 26, width: 110, height: 52, rx: 8, fill: '#E9F1FB', stroke: '#D3E2F4' }, g);
      elNS('rect', { x: z.x + 24, y: z.y - 18, width: 72, height: 36, rx: 7, fill: '#EFF5FC', stroke: '#D3E2F4' }, g);
    }
    var t = elNS('text', { x: z.x, y: z.y + 74, 'text-anchor': 'middle', 'font-size': 20, 'font-weight': 600, fill: labelColor }, g);
    t.textContent = z.label;
  }

  /* ---------- 寄存点图层 ---------- */
  function drawZones() {
    while (zoneLayer.firstChild) zoneLayer.removeChild(zoneLayer.firstChild);
    if (!showPickup) return;
    locations.filter(function (l) { return l.zone && LF.zones.get(l.zone); })
      .forEach(function (l) {
        var z = LF.zones.get(l.zone);
        var g = elNS('g', { 'class': 'pickup-mk' }, zoneLayer);
        elNS('circle', { cx: z.x, cy: z.y - 6, r: 14, fill: '#fff', stroke: '#2d6cdf', 'stroke-width': 2 }, g);
        var t = elNS('text', { x: z.x, y: z.y - 1, 'text-anchor': 'middle', 'font-size': 14 }, g);
        t.textContent = '📍';
        var tip = elNS('title', {}, g);
        tip.textContent = l.name + '（' + (l.address || '') + ' ' + (l.open_hours || '') + '）';
      });
  }

  /* ---------- 物品图层 ---------- */
  function drawItems() {
    while (itemsLayer.firstChild) itemsLayer.removeChild(itemsLayer.firstChild);

    // 按区分组，同一区的物品从锚点向外环形散开；空 area 进「未定位」
    var groups = {};
    items.forEach(function (it) {
      var key = (it.area && LF.zones.get(it.area)) ? it.area : '__unknown';
      (groups[key] = groups[key] || []).push(it);
    });

    Object.keys(groups).forEach(function (code) {
      var anchor = code === '__unknown' ? LF.zones.unknownPocket : LF.zones.get(code);
      var rows = groups[code];
      var n = rows.length;
      rows.forEach(function (it, i) {
        var ang = (-90 + i * (360 / Math.max(n, 1))) * Math.PI / 180;
        var r = n > 8 ? 40 + Math.floor(i / n) * 30 : 44;   // 超过 8 条加外圈
        var x = anchor.x + r * Math.cos(ang);
        var y = anchor.y + r * Math.sin(ang) - (code === '__unknown' ? 0 : 14);
        drawMarker(it, x, y);
      });
    });
  }

  function drawMarker(it, x, y) {
    var isFound = it.postType === 'found';
    var g = elNS('g', {
      'class': 'item-mk ' + (isFound ? 'mk-found' : 'mk-lost'),
      'data-id': it.id
    }, itemsLayer);
    elNS('circle', { cx: x, cy: y, r: 15, fill: '#fff', 'stroke-width': 2 }, g);
    var t = elNS('text', { x: x, y: y + 5, 'text-anchor': 'middle', 'font-size': 15 }, g);
    t.textContent = emojiOf(it);
    var tip = elNS('title', {}, g);
    tip.textContent = 'LF-' + it.id + ' ' + (it.title || '') + (isFound ? '（待认领）' : '（失者寻物）');
    g.addEventListener('click', function (e) {
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent('lf:focus-item', { detail: { id: it.id } }));
    });
  }

  /* ---------- 联动：广场卡片 → 地图标记脉冲 ---------- */
  function focusItem(id) {
    var g = itemsLayer.querySelector('.item-mk[data-id="' + id + '"]');
    if (!g) return;   // 被过滤掉或未定位区外，静默
    if (view.s > 1) {
      // 平移把标记带到视野中心：c = t + p*s → t = c - p*s（钳制交给 applyView）
      var cx = parseFloat(g.querySelector('circle').getAttribute('cx'));
      var cy = parseFloat(g.querySelector('circle').getAttribute('cy'));
      view.tx = W / 2 - cx * view.s;
      view.ty = H / 2 - cy * view.s;
      applyView();
    }
    g.classList.add('pulse');
    setTimeout(function () { g.classList.remove('pulse'); }, 2200);
  }

  /* ---------- 缩放平移手势 ---------- */
  function bindGestures() {
    var pointers = {};   // pointerId -> {x,y}
    var drag = null;     // 单指/拖拽 {lastX,lastY}
    var pinch = null;    // 双指 {d0, s0, mid0}

    function middle() {
      var ids = Object.keys(pointers);
      var a = pointers[ids[0]], b = pointers[ids[1]];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
    }

    svg.addEventListener('wheel', function (e) {
      if (!e.ctrlKey && !e.metaKey) return;   // 普通滚轮 = 页面滚动，不抢
      e.preventDefault();
      zoomAt(toCanvas(e.clientX, e.clientY), e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });

    svg.addEventListener('dblclick', function (e) {
      zoomAt(toCanvas(e.clientX, e.clientY), 1.4);
    });

    svg.addEventListener('pointerdown', function (e) {
      svg.setPointerCapture(e.pointerId);
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(pointers);
      if (ids.length === 1) {
        drag = { x: e.clientX, y: e.clientY };
      } else if (ids.length === 2) {
        drag = null;
        var m = middle();
        pinch = { d0: m.d, s0: view.s, cx0: toCanvas(m.x, m.y) };
      }
    });

    svg.addEventListener('pointermove', function (e) {
      if (!pointers[e.pointerId]) return;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(pointers);
      if (ids.length >= 2 && pinch) {
        var m = middle();
        var f = m.d / pinch.d0;
        var s2 = Math.min(S_MAX, Math.max(S_MIN, pinch.s0 * f));
        // 以捏合中点为缩放中心
        var p = toCanvas(m.x, m.y);
        view.tx = p.x - (p.x - view.tx) * (s2 / view.s);
        view.ty = p.y - (p.y - view.ty) * (s2 / view.s);
        view.s = s2;
        applyView();
      } else if (drag) {
        var r = svg.getBoundingClientRect();
        var k = Math.min(r.width / W, r.height / H);
        view.tx += (e.clientX - drag.x) / k;
        view.ty += (e.clientY - drag.y) / k;
        drag = { x: e.clientX, y: e.clientY };
        applyView();
      }
    });

    function release(e) {
      delete pointers[e.pointerId];
      if (Object.keys(pointers).length === 1) {
        var id0 = Object.keys(pointers)[0];
        drag = { x: pointers[id0].x, y: pointers[id0].y };
        pinch = null;
      } else if (!Object.keys(pointers).length) {
        drag = null; pinch = null;
      }
    }
    svg.addEventListener('pointerup', release);
    svg.addEventListener('pointercancel', release);
  }

  /* ---------- 挂载 ---------- */
  LF.map.init = function (box) {
    if (!box || !LF.zones) return;
    container = box;

    svg = elNS('svg', {
      viewBox: '0 0 ' + W + ' ' + H,
      preserveAspectRatio: 'xMidYMid meet',
      'class': 'campus-svg'
    });
    world = elNS('g', {}, svg);
    drawBase();
    zoneLayer = elNS('g', { 'class': 'layer-pickup' }, world);
    itemsLayer = elNS('g', { 'class': 'layer-items' }, world);
    container.appendChild(svg);

    // 覆盖按钮：寄存点图层开关 + 复位 + 手势提示
    container.appendChild(elHTML(
      '<button type="button" class="map-btn map-btn-pickup active" id="map-pickup-toggle" title="显示/隐藏寄存点">📍 寄存点</button>' +
      '<button type="button" class="map-btn map-btn-reset" id="map-reset" title="回到全图">⤢ 复位</button>' +
      '<div class="map-hint">电脑 Ctrl+滚轮缩放 · 手机双指捏合 · 拖拽平移</div>'
    ));

    container.querySelector('#map-pickup-toggle').addEventListener('click', function () {
      showPickup = !showPickup;
      this.classList.toggle('active', showPickup);
      drawZones();
    });
    container.querySelector('#map-reset').addEventListener('click', resetView);

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
