/**
 * assets/zones.js —— 校园七区配置（地图的唯一事实源）
 *
 * 三个消费方必须引用同一份配置：
 *   1. 前端地图（assets/map.js，腾讯地图 GL JS）—— 区域锚点坐标、寄存点位置
 *   2. 阿寻提示词（agents/lost-found-assistant.md 的 area 枚举）—— 登记「两问」的第一问
 *   3. 数据库列 lost_items.area / locations.zone —— 枚举值即下面的 code
 *
 * 坐标系：GCJ-02（火星坐标，腾讯地图原生坐标系，无需换算）。
 * 来源（2026-11-09 经腾讯地图 POI 检索 + 官网/新闻网交叉核对）：
 *   - 东/西教学楼、东园/西园宿舍、东足球场（东运动场）、体育馆：腾讯地图 POI 精确坐标
 *   - 西操场（西运动场及看台）：官方校园平面图上位于西园宿舍与西教学楼之间，
 *     POI 未收录精确点，坐标为按相对位置估算——校准是允许的，改数字即可
 *   - 校区中心 (22.801604, 113.9539)、各门坐标同源，用于核对范围
 */
(function () {
  'use strict';
  window.LF = window.LF || {};

  LF.zones = {
    /* 地图初始视野：一期校园全貌 */
    center: { lat: 22.8012, lng: 113.9548 },
    zoom: 16,
    minZoom: 14,
    maxZoom: 19,

    /* 七区：code 与数据库枚举、阿寻提示词逐字一致 */
    list: [
      { code: 'east_teaching',   label: '东教学楼群', lat: 22.803451, lng: 113.956948 },
      { code: 'west_teaching',   label: '西教学楼群', lat: 22.799352, lng: 113.950560 },
      { code: 'east_playground', label: '东操场',     lat: 22.801671, lng: 113.959454 },
      { code: 'west_playground', label: '西操场',     lat: 22.798800, lng: 113.947000 },
      { code: 'east_dorm',       label: '东园宿舍',   lat: 22.802354, lng: 113.963930 },
      { code: 'west_dorm',       label: '西园宿舍',   lat: 22.798887, lng: 113.944853 },
      { code: 'gym',             label: '体育馆',     lat: 22.804132, lng: 113.950555 }
    ],

    /* 同一区物品的散开半径（米）：从锚点向外环形分布，防止压住寄存点 */
    spread: { ring: 38, gap: 12, maxRing: 3 },

    byCode: {},
    init: function () {
      for (var i = 0; i < this.list.length; i++) this.byCode[this.list[i].code] = this.list[i];
    },
    get: function (code) { return this.byCode[code] || null; }
  };
  LF.zones.init();

  /* 「未定位」收纳点：area 为空的老记录画在这里（南门内侧空地） */
  LF.zones.unknownPocket = { code: '__unknown', label: '未定位', lat: 22.7966, lng: 113.9552 };
})();
