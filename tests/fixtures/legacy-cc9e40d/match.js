/**
 * assets/match.js —— 匹配度标注与候选收敛（C 拥有，A 已放基线）
 *
 * 对外契约：
 *   LF.match.annotate(rows)  -> rows 附加 {label, level}
 *   LF.match.topN(rows, n)   -> 截断候选
 *
 * 可优化点（C）：
 *   1. 分级阈值应按真实数据校准（现在是拍脑袋的 0.5 / 0.25）；
 *   2. 同一物品重复发布时的去重合并；
 *   3. 低置信度时的「相似推荐」话术。
 */
(function () {
  'use strict';
  LF.match = {};

  var HIGH = 0.5, MID = 0.25;

  LF.match.annotate = function (rows) {
    return rows.map(function (r) {
      var level = r.score >= HIGH ? 'high' : (r.score >= MID ? 'mid' : 'low');
      var label = level === 'high'
        ? '很可能就是它 · ' + Math.round(r.score * 100) + '%'
        : (level === 'mid'
          ? '有点接近 · ' + Math.round(r.score * 100) + '%'
          : '参考项 · ' + Math.round(r.score * 100) + '%');
      return Object.assign({}, r, { level: level, label: label });
    });
  };

  LF.match.topN = function (rows, n) {
    return rows.slice(0, n || 20);
  };
})();
