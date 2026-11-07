/**
 * tests/lib/corpus.mjs —— 合成语料 + 历史实现的批量执行器
 *
 * ⚠️ 这里全部是**合成数据**，不含任何生产记录。
 *    覆盖：标题奖励 1.15、重复关键词、隐藏细节加分门槛、returned/claimed、
 *          同分排序、中文标点、大小写、emoji、字典快照差异（wallet/clear）。
 */

/** 主语料：给"算法语义"用例用 */
export const CORPUS = [
  // 1) title=aa、query=aa -> base 1.0 + 标题奖励 0.15 = 1.15
  //    category=wallet / color_tone=clear 不在历史字典里 -> label 为空 -> haystack 恰好是 'aa'
  { id: 101, title: 'aa', detail: null, category: 'wallet', colorTone: 'clear',
    notice: null, aiTags: null, status: 'open', postType: 'found', created: '2026-11-01T10:00:00Z' },

  // 2) 正常招领帖：黑色耳机
  { id: 102, title: '黑色·耳机', detail: '右耳柄外侧有一道浅划痕', category: 'headphones',
    colorTone: 'black', notice: '操场东侧看台捡到一副黑色无线耳机', aiTags: ['耳机', '黑色'],
    status: 'open', postType: 'found', created: '2026-11-06T23:30:00Z' },

  // 3) 隐藏细节命中的主用例：「写有名字的证件卡」
  { id: 103, title: '粉色·证件卡', detail: '学生证上面名字是：格里菲斯', category: 'card',
    colorTone: 'pink', notice: '相山餐厅二楼捡到一张粉色卡套的学生证', aiTags: null,
    status: 'open', postType: 'found', created: '2026-11-06T12:31:00Z' },

  // 4) returned：分再高也必须被剔除
  { id: 104, title: '黑色·耳机', detail: '右耳柄外侧有一道浅划痕', category: 'headphones',
    colorTone: 'black', notice: '操场东侧看台捡到一副黑色无线耳机', aiTags: null,
    status: 'returned', postType: 'found', created: '2026-11-06T22:00:00Z' },

  // 5) claimed：保留
  { id: 105, title: '黑色·耳机', detail: '左耳壳有一道裂纹', category: 'headphones',
    colorTone: 'black', notice: '操场东侧看台捡到一副黑色无线耳机', aiTags: null,
    status: 'claimed', postType: 'found', created: '2026-11-06T21:00:00Z' },

  // 6/7) 完全同分同时间 -> 走 tie-break（created_at DESC, id DESC）
  { id: 106, title: '蓝色·雨伞', detail: null, category: 'umbrella', colorTone: 'blue',
    notice: '图书馆门口捡到一把蓝色雨伞', aiTags: null, status: 'open', postType: 'found',
    created: '2026-11-05T09:00:00Z' },
  { id: 107, title: '蓝色·雨伞', detail: null, category: 'umbrella', colorTone: 'blue',
    notice: '图书馆门口捡到一把蓝色雨伞', aiTags: null, status: 'open', postType: 'found',
    created: '2026-11-05T09:00:00Z' },

  // 8) 中文标点：title 里的（）必须被清掉
  { id: 108, title: '钥匙（宿舍）', detail: '钥匙串上挂了一只黄色小鸭子', category: 'keys',
    colorTone: 'other', notice: '宿舍楼下捡到一串钥匙', aiTags: null, status: 'open',
    postType: 'found', created: '2026-11-04T08:00:00Z' },

  // 9) 大小写：title 是 iPhone，query 用小写 iphone
  { id: 109, title: 'iPhone 15', detail: '锁屏壁纸是一只橘猫', category: 'phone',
    colorTone: 'white', notice: '教学楼捡到一台手机', aiTags: null, status: 'open',
    postType: 'found', created: '2026-11-03T08:00:00Z' },

  // 10) 纯 emoji：两侧语义一致
  { id: 110, title: '😀', detail: null, category: null, colorTone: null, notice: null,
    aiTags: null, status: 'open', postType: 'lost', created: '2026-11-02T08:00:00Z' },

  // 11/12) emoji 与汉字相邻：已知差异用例（JS 按 UTF-16 code unit，PG 按码点）
  { id: 111, title: '杯子😀', detail: null, category: 'cup', colorTone: null, notice: null,
    aiTags: null, status: 'open', postType: 'found', created: '2026-11-02T07:00:00Z' },
  { id: 112, title: '杯子😀x', detail: null, category: 'cup', colorTone: null, notice: null,
    aiTags: null, status: 'open', postType: 'found', created: '2026-11-02T06:00:00Z' },

  // 13) detail 为空：sec 分支不能炸
  { id: 113, title: '黑色·耳机', detail: null, category: 'headphones', colorTone: 'black',
    notice: '食堂门口捡到黑色耳机', aiTags: null, status: 'open', postType: 'lost',
    created: '2026-11-06T18:00:00Z' },

  // 14) 同义词：书包 -> 背包/双肩包/包
  { id: 114, title: '灰色·书包', detail: '侧面网兜里有一瓶没喝完的矿泉水', category: 'bag',
    colorTone: 'gray', notice: '图书馆三楼捡到一个灰色双肩包', aiTags: null, status: 'open',
    postType: 'found', created: '2026-11-06T18:00:00Z' },

  // 15) 对照：detail 与 query 无交集 -> sec = 0 -> 不走私有信号分支
  { id: 115, title: '黑色·水杯', detail: '杯底贴了一张星星贴纸', category: 'cup',
    colorTone: 'black', notice: '操场捡到黑色水杯', aiTags: null, status: 'open',
    postType: 'found', created: '2026-11-06T17:00:00Z' },

  // 16) 防猜：detail 高度吻合但公开字段完全不沾边 -> base 不达标，不许加分
  { id: 116, title: '蓝色·雨伞', detail: '伞柄上刻了张三丰三个字', category: 'umbrella',
    colorTone: 'blue', notice: null, aiTags: null, status: 'open', postType: 'found',
    created: '2026-11-06T16:00:00Z' },

  // 17) 有正则元字符的 notice：不能把 SQL 正则当注入面
  { id: 117, title: '白色·证件卡', detail: '卡套背面贴了一张 [已过期] 标签', category: 'card',
    colorTone: 'white', notice: '一食堂捡到白色证件卡 (学生卡). 背面有字',
    aiTags: null, status: 'open', postType: 'found', created: '2026-11-06T15:00:00Z' },

  // 18) 分数超过 1：base 1.0 + min(0.05+0.15, 0.3) = 1.2
  { id: 118, title: 'bb', detail: null, category: 'glasses', colorTone: 'brown', notice: null,
    aiTags: null, status: 'open', postType: 'lost', created: '2026-11-01T09:00:00Z' }
];

/** 把语料映射成历史 LF.api.rowToItem 那样的对象（前端字段名） */
export function toLegacyItems(rows) {
  return rows.map((r) => ({
    id: r.id,
    title: r.title || '',
    detail: r.detail || '',
    location: r.location || '',
    image: null,
    colorFeature: null,
    aiDesc: '',
    aiTags: Array.isArray(r.aiTags) ? r.aiTags : (r.aiTags || []),
    notice: r.notice || '',
    category: r.category || '',
    colorTone: r.colorTone || '',
    status: r.status || 'open',
    postType: r.postType || 'lost',
    pickupLocation: '',
    time: r.pubTime || '',
    createdAt: r.created
  }));
}

/**
 * 历史前端拿到的候选集：LF.api.listItems 按 created_at DESC 取 1000 条，
 * 广场再 filter(status !== 'returned')。这一步必须在 JS 侧复刻，
 * 否则就变成"SQL 有截断、JS 没有"，对照无从谈起。
 */
export function legacyCandidates(rows, limit = 1000) {
  return toLegacyItems(rows)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id))
    .slice(0, limit)
    .filter((it) => it.status !== 'returned');
}

/** 跑历史实现，返回 [{id, score, level, label}]（已过滤 >0.08 并排序） */
export function runLegacy(legacy, rows, query, keywords = [], limit = 1000) {
  const cands = legacyCandidates(rows, limit);
  const scored = legacy.searchText(cands, query, keywords);
  const annotated = legacy.annotate(scored);
  return annotated.map((r) => ({
    id: r.item.id,
    score: r.score,
    level: r.level,
    label: r.label
  }));
}
