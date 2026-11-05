/**
 * assets/search.js —— 检索算法（C 拥有，A 已放可运行基线，请在此基础上优化）
 *
 * 对外契约：
 *   LF.search.text(items, query, keywords) -> [{item, score}]   已按分数倒序
 *   LF.search.image(items, feat, aiDesc)   -> [{item, score}]   颜色 + 语义混合
 *
 * 已知可优化点（C 的活）：
 *   1. 现在只有内置同义词表 + 2-gram，召回弱：建议接 LF.ai.expandQuery 的 keywords 做加权召回；
 *   2. 支持错别字 / 拼音首字母（如 "erji" 命中 "耳机"）；
 *   3. 图片检索：把 ai_desc / ai_tags 的语义相似度做成主信号，颜色退为加分项；
 *   4. 阈值与排序策略需用真实数据回归（建议在 tests/ 下留 20 条种子数据做对照）。
 *
 * 注意：搜索打分只使用公开字段（title / aiDesc / aiTags / image），
 *      不使用 detail（隐藏细节），避免通过检索反推失主信息。
 */
(function () {
  'use strict';
  LF.search = {};

  var SYNONYMS = {
    '伞': ['雨伞', '遮阳伞', 'umbrella'],
    '书包': ['背包', '双肩包', '包'],
    '手机': ['电话', 'iphone', '安卓机'],
    '钥匙': ['钥匙串', 'key'],
    '钱包': ['皮夹', '钱夹'],
    '耳机': ['蓝牙耳机', '耳麦', 'airpods', '无线耳机'],
    '水杯': ['杯子', '保温杯', '水壶'],
    '电脑': ['笔记本', 'laptop', 'macbook'],
    '黑色': ['黑', '深色'],
    '蓝色': ['蓝', '深蓝'],
    '白色': ['白', '浅色'],
    '红色': ['红']
  };

  function expand(text) {
    var t = String(text || '').toLowerCase();
    Object.keys(SYNONYMS).forEach(function (k) {
      if (t.indexOf(k) >= 0) t += ' ' + SYNONYMS[k].join(' ');
    });
    return t;
  }

  function ngrams(text, n) {
    n = n || 2;
    var t = expand(text).replace(/[\s，。,.!?！？、；;：:"'（）()【】\[\]]/g, '');
    var set = new Set();
    if (t.length < n) { if (t) set.add(t); return set; }
    for (var i = 0; i <= t.length - n; i++) set.add(t.slice(i, i + n));
    return set;
  }

  function dice(a, b) {
    var A = ngrams(a), B = ngrams(b);
    if (!A.size || !B.size) return 0;
    var inter = 0;
    A.forEach(function (x) { if (B.has(x)) inter++; });
    return (2 * inter) / (A.size + B.size);
  }

  function haystack(it) {
    var tags = Array.isArray(it.aiTags) ? it.aiTags.join(' ') : '';
    return [it.title, it.aiDesc, tags].filter(Boolean).join(' ');
  }

  /** 文字检索 */
  LF.search.text = function (items, query, keywords) {
    keywords = keywords || [];
    var qExpanded = expand(query) + ' ' + keywords.join(' ');
    return items.map(function (it) {
      var text = haystack(it);
      var base = dice(qExpanded, text);
      var bonus = 0;
      keywords.forEach(function (k) {
        if (k && text.toLowerCase().indexOf(String(k).toLowerCase()) >= 0) bonus += 0.05;
      });
      if (it.title && query && it.title.indexOf(query) >= 0) bonus += 0.15;
      return { item: it, score: Math.min(1, base + Math.min(bonus, 0.3)) };
    })
      .filter(function (x) { return x.score > 0.08; })
      .sort(function (a, b) { return b.score - a.score; });
  };

  /** 图片检索：有 AI 描述时按语义主判，颜色做补充 */
  LF.search.image = function (items, feat, aiDesc) {
    var hasDesc = !!aiDesc;
    return items.map(function (it) {
      var score = 0;
      if (it.colorFeature && feat) {
        var d = LF.ui.colorDistance(feat, it.colorFeature);
        score += (1 - d / LF.ui.MAX_COLOR_DIST) * (hasDesc ? 0.45 : 1);
      }
      if (hasDesc) {
        score += dice(aiDesc, haystack(it)) * 0.55;
      }
      return { item: it, score: score };
    })
      .filter(function (x) { return x.score > (hasDesc ? 0.3 : 0.55); })
      .sort(function (a, b) { return b.score - a.score; });
  };
})();
