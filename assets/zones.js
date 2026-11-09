/**
 * assets/zones.js —— 校园七区配置（地图的唯一事实源）
 *
 * 设计文档：docs/PLAN-MAP-MODULE.md
 * 三个消费方必须引用同一份配置：
 *   1. 前端地图（assets/map.js）—— 区域锚点坐标、寄存点位置
 *   2. 阿寻提示词（agents/lost-found-assistant.md 的 area 枚举）—— 登记「两问」的第一问
 *   3. 数据库列 lost_items.area / locations.zone —— 枚举值即下面的 code
 *
 * 坐标 (x,y) 是 SVG 底图画布上的示意占位（画布 1000×700）。
 * 校准方法：把真实校区平面图垫到底图里（map.js 支持 IMAGE_UNDERLAY），
 * 逐区点出中心坐标改这里的数字即可，代码零改动。
 * 底图的建筑/道路也按这份坐标自动生成——改坐标，图跟着变。
 */
(function () {
  'use strict';
  window.LF = window.LF || {};

  /* 底图画布逻辑尺寸 */
  var W = 1000, H = 700;

  LF.zones = {
    width: W,
    height: H,

    /* 七区：code 与数据库枚举、阿寻提示词逐字一致 */
    list: [
      { code: 'east_teaching',   label: '东教学楼群', x: 640, y: 280 },
      { code: 'west_teaching',   label: '西教学楼群', x: 360, y: 280 },
      { code: 'east_playground', label: '东操场',     x: 810, y: 430 },
      { code: 'west_playground', label: '西操场',     x: 190, y: 430 },
      { code: 'east_dorm',       label: '东园宿舍',   x: 660, y: 570 },
      { code: 'west_dorm',       label: '西园宿舍',   x: 340, y: 570 },
      { code: 'gym',             label: '体育馆',     x: 500, y: 130 }
    ],

    byCode: {},
    init: function () {
      for (var i = 0; i < this.list.length; i++) this.byCode[this.list[i].code] = this.list[i];
    },
    get: function (code) { return this.byCode[code] || null; }
  };
  LF.zones.init();

  /* 「未定位」收纳点：area 为空的老记录画在这里（画布右下角） */
  LF.zones.unknownPocket = { code: '__unknown', label: '未定位', x: 930, y: 640 };
})();
