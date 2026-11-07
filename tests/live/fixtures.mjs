/**
 * tests/live/fixtures.mjs —— 真实联调用的**合成**种子与查询用例
 *
 * 全部是编的，与生产记录无关。
 * 清场标记放在 owner_id（= LFTEST_SEED）而不是 title 前缀：
 * title 是参与打分的字段，加前缀会把「query=aa、title=aa → 1.15」这个锚点改掉。
 *
 * created 全部显式指定（±秒级间隔），让「候选顺序」确定：
 * 函数按 created_at DESC 取前 1000，历史 JS 用同一顺序，两侧才可比。
 */

export const SEED_MARK = 'LFTEST_SEED';

/** @typedef {{key:string,title:string,detail:string|null,category:string,colorTone:string,notice:string|null,aiTags:string[]|null,status:string,postType:string,created:string}} SeedRow */

/** @type {SeedRow[]} */
export const SEED = [
  {
    key: 'headphones_open',
    title: '黑色·耳机',
    detail: '右耳柄外侧有一道浅划痕',
    category: 'headphones', colorTone: 'black',
    notice: '操场东侧看台捡到一副黑色无线耳机',
    aiTags: ['耳机', '黑色'], status: 'open', postType: 'found',
    created: '2026-11-06T23:30:00Z'
  },
  {
    key: 'card_detail',
    title: '粉色·证件卡',
    detail: '学生证上面名字是：格里菲斯',
    category: 'card', colorTone: 'pink',
    notice: '相山餐厅二楼捡到一张粉色卡套的学生证',
    aiTags: null, status: 'open', postType: 'found',
    created: '2026-11-06T12:31:00Z'
  },
  {
    key: 'headphones_returned',
    title: '黑色·耳机',
    detail: '右耳柄外侧有一道浅划痕',
    category: 'headphones', colorTone: 'black',
    notice: '操场东侧看台捡到一副黑色无线耳机',
    aiTags: null, status: 'returned', postType: 'found',
    created: '2026-11-06T22:00:00Z'
  },
  {
    key: 'headphones_claimed',
    title: '黑色·耳机',
    detail: '左耳壳有一道裂纹',
    category: 'headphones', colorTone: 'black',
    notice: '操场东侧看台捡到一副黑色无线耳机',
    aiTags: null, status: 'claimed', postType: 'found',
    created: '2026-11-06T21:00:00Z'
  },
  {
    key: 'double_a',
    title: 'aa',
    detail: null,
    // wallet / clear 不在 cc9e40d 的字典里 -> label 为空 -> haystack 恰好是 'aa'
    category: 'wallet', colorTone: 'clear',
    notice: null, aiTags: null, status: 'open', postType: 'found',
    created: '2026-11-01T10:00:00Z'
  },
  {
    key: 'emoji',
    title: '杯子😀',
    detail: null,
    category: 'cup', colorTone: 'white',
    notice: null, aiTags: null, status: 'open', postType: 'found',
    created: '2026-11-02T07:00:00Z'
  },
  {
    key: 'card_punct',
    title: '白色·证件卡',
    detail: '卡套背面贴了一张 [已过期] 标签',
    category: 'card', colorTone: 'white',
    notice: '一食堂捡到白色证件卡 (学生卡). 背面有字',
    aiTags: null, status: 'open', postType: 'found',
    created: '2026-11-06T15:00:00Z'
  },
  {
    key: 'umbrella',
    title: '蓝色·雨伞',
    detail: null,
    category: 'umbrella', colorTone: 'blue',
    notice: '图书馆门口捡到一把蓝色雨伞',
    aiTags: null, status: 'open', postType: 'lost',
    created: '2026-11-05T09:00:00Z'
  }
];

/**
 * 查询用例。expect 只写「结构性期望」，具体分数由历史 JS 现算：
 *   minRows —— 至少几条（0 表示负向用例，必须为空）
 *   mustInclude —— 必须出现的 key（用来证明不是空数组蒙过）
 *
 * ⚠️ 这里**没有 keywords 字段**：v1 起两端统一成「只 trim 原话 + p_keywords 固定 []」，
 * 同义词由 SQL 内置字典处理。用例里再塞关键词，就测不到网页真正发出的那组参数了。
 */
export const CASES = [
  { query: '黑色耳机', limit: 10, minRows: 2, mustInclude: ['headphones_open', 'headphones_claimed'] },
  { query: '证件卡', limit: 10, minRows: 2, mustInclude: ['card_detail', 'card_punct'] },
  { query: 'aa', limit: 3, minRows: 1, mustInclude: ['double_a'] },
  { query: '😀', limit: 5, minRows: 1, mustInclude: ['emoji'] },
  { query: '雨伞', limit: 5, minRows: 1, mustInclude: ['umbrella'] },
  // 首尾带空白：两端都只 trim，结果必须和「雨伞」一模一样
  { query: '  雨伞  ', limit: 5, minRows: 1, mustInclude: ['umbrella'], sameAs: '雨伞' },
  { query: '这个词一定不存在xyz', limit: 5, minRows: 0, mustInclude: [] }
];

/** 种子 → 历史 JS 能吃的语料形状（id 由插入后回填） */
export function toCorpus(seedWithIds) {
  return seedWithIds.map((r) => ({
    id: r.id,
    title: r.title,
    detail: r.detail,
    category: r.category,
    colorTone: r.colorTone,
    notice: r.notice,
    aiTags: r.aiTags,
    status: r.status,
    postType: r.postType,
    created: r.created
  }));
}
