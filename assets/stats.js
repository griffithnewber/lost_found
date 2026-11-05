/**
 * assets/stats.js —— 数据统计（C 拥有，A 只放了最简基线）
 *
 * 对外契约：
 *   LF.stats.compute(items) -> { total, open, claimed, byCategory:[{name,count}], byDay:[{day,count}] }
 *
 * 建议 C 做的事：
 *   1. 品类识别：先用关键词表，后续可换 LF.ai 打标签；
 *   2. 渲染成简单条形图（纯 CSS 即可，不引入图表库）；
 *   3. 到期归档：超过 30 天未认领 → status = 'expired'（用 LF.api.updateItem）。
 */
(function () {
  'use strict';
  LF.stats = {};

  var CATS = [
    { name: '数码', keys: ['手机', '耳机', '电脑', '充电', 'airpods', '相机', 'U盘', '鼠标'] },
    { name: '证件卡片', keys: ['卡', '证', '身份证', '学生证', '钥匙'] },
    { name: '包袋', keys: ['包', '书包', '背包', '行李箱'] },
    { name: '衣物饰品', keys: ['衣', '外套', '帽', '围巾', '眼镜', '手表'] },
    { name: '书籍文具', keys: ['书', '笔', '本', '资料'] },
    { name: '雨具水杯', keys: ['伞', '雨衣', '杯', '水壶'] }
  ];

  function categoryOf(it) {
    var text = [it.title, it.aiDesc, (it.aiTags || []).join(' ')].filter(Boolean).join(' ');
    for (var i = 0; i < CATS.length; i++) {
      for (var j = 0; j < CATS[i].keys.length; j++) {
        if (text.indexOf(CATS[i].keys[j]) >= 0) return CATS[i].name;
      }
    }
    return '其他';
  }

  LF.stats.compute = function (items) {
    var byCategory = {};
    var byDay = {};
    var open = 0, claimed = 0;

    items.forEach(function (it) {
      var c = categoryOf(it);
      byCategory[c] = (byCategory[c] || 0) + 1;
      if (it.status === 'claimed') claimed++; else open++;
      var d = it.time ? String(it.time).slice(0, 10) : '';
      if (d) byDay[d] = (byDay[d] || 0) + 1;
    });

    function toArr(obj) {
      return Object.keys(obj).map(function (k) { return { name: k, count: obj[k] }; })
        .sort(function (a, b) { return b.count - a.count; });
    }

    return {
      total: items.length,
      open: open,
      claimed: claimed,
      byCategory: toArr(byCategory),
      byDay: toArr(byDay)
    };
  };
})();
