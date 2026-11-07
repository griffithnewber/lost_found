/**
 * tests/sql/lf_search_parity.test.mjs
 *
 * 目的：把 db/migrations/2026-11-07_lf_search_text_v1.sql 的 SQL 实现
 *      与 cc9e40d 的历史 JS 实现（tests/fixtures/legacy-cc9e40d/）逐条对照。
 *
 * 跑法：
 *   cd tests && npm install && node --test
 *
 * 测试库：PGlite（PostgreSQL 16.4 WASM），内存实例，与生产库完全隔离。
 * 语料：tests/lib/corpus.mjs 里的合成数据，不含任何生产记录。
 *
 * 本版要点（第二轮）：
 *   * emoji 不再是"已知差异"：n-gram 已改成 UTF-16 code unit 语义，
 *     emoji 与汉字相邻的记录必须与历史 JS **逐分相同**，语料 110/111/112 全部进主对照。
 *   * 同分排序是**新增的确定性规则**（历史 JS 靠稳定排序保持入参顺序），
 *     对照时 JS 侧也按 created_at DESC, id DESC 排好候选，两边比的是同一顺序。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import { loadLegacyJs } from '../lib/legacy.mjs';
import { CORPUS, runLegacy, legacyCandidates } from '../lib/corpus.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const MIGRATION = path.join(ROOT, 'db', 'migrations', '2026-11-07_lf_search_text_v1.sql');
const SCHEMA = path.join(ROOT, 'tests', 'fixtures', 'schema_lost_items.sql');

const TOL = 1e-12;

const legacy = loadLegacyJs();

/** 把语料写进测试库 */
async function seed(db, rows) {
  for (const r of rows) {
    await db.query(
      `INSERT INTO lost_items
         (id, title, detail, location, notice, status, post_type, pub_time,
          category, color_tone, ai_tags, created_at)
       OVERRIDING SYSTEM VALUE
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::timestamptz)`,
      [
        r.id, r.title, r.detail, r.location || null, r.notice,
        r.status, r.postType, r.pubTime || null,
        r.category, r.colorTone,
        r.aiTags ? JSON.stringify(r.aiTags) : null,
        r.created
      ]
    );
  }
}

/** 调共享函数 */
async function runSql(db, query, keywords = [], limit = 200) {
  const res = await db.query(
    'SELECT * FROM public.lf_search_text_v1($1, $2::text[], $3::int)',
    [query, keywords, limit]
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    score: Number(r.score),
    level: r.level,
    label: r.label,
    rank: Number(r.rank),
    status: r.status,
    algorithm_version: r.algorithm_version
  }));
}

/** 从库里读真实的 haystack 再算 base，避免手抄 notice/ai_tags 抄错导致"假不一致"。
 *  注意必须复刻函数内部的 qExpanded：expand(query) + ' ' + keywords.join(' ')，
 *  再把这一整串交给 lf_dice_v1（dice 内部还会再 expand 一次，历史 JS 同样如此）。 */
async function baseOf(db, id, query, keywords = []) {
  const res = await db.query(
    `SELECT lf_dice_v1(
              lf_expand_v1($1) || ' ' || coalesce(array_to_string($2::text[], ' '), ''),
              lf_haystack_v1(title, color_tone, category, notice, ai_tags)) AS v
       FROM lost_items WHERE id = $3`,
    [query, keywords, id]
  );
  return Number(res.rows[0].v);
}

function fmt(rows) {
  return rows.map((r) => `#${r.id} ${r.score.toFixed(4)} ${r.level}`).join(' | ') || '(空)';
}

/** 逐条断言两份结果在 id 序列 / 分数 / 分级 / 文案上一致 */
function assertParity(jsRows, sqlRows, label) {
  const jsIds = jsRows.map((r) => r.id);
  const sqlIds = sqlRows.map((r) => r.id);
  assert.deepEqual(sqlIds, jsIds, `${label}：候选顺序不一致\n JS: ${fmt(jsRows)}\nSQL: ${fmt(sqlRows)}`);
  for (let i = 0; i < jsRows.length; i++) {
    assert.ok(
      Math.abs(jsRows[i].score - sqlRows[i].score) <= TOL,
      `${label}：#${jsRows[i].id} 分数不一致 JS=${jsRows[i].score} SQL=${sqlRows[i].score}`
    );
    assert.equal(sqlRows[i].level, jsRows[i].level, `${label}：#${jsRows[i].id} 分级不一致`);
    assert.equal(sqlRows[i].label, jsRows[i].label, `${label}：#${jsRows[i].id} label 不一致`);
    assert.equal(sqlRows[i].rank, i + 1, `${label}：rank 应从 1 连续递增`);
  }
}

describe('lf_search_text_v1 与历史 JS 对照', () => {
  let db;

  before(async () => {
    db = new PGlite();
    await db.exec(fs.readFileSync(SCHEMA, 'utf8'));
    await db.exec(fs.readFileSync(MIGRATION, 'utf8'));
    await seed(db, CORPUS);
  });

  after(async () => {
    await db.close();
  });

  it('迁移文件能在空库上建立全部函数', async () => {
    const res = await db.query(
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND proname LIKE 'lf\\_%' ORDER BY proname`
    );
    const names = res.rows.map((r) => r.proname);
    assert.deepEqual(names, [
      'lf_ai_tags_text_v1',
      'lf_bigrams_v1',
      'lf_category_label_v1',
      'lf_color_label_v1',
      'lf_dice_v1',
      'lf_expand_v1',
      'lf_haystack_v1',
      'lf_search_text_v1',
      'lf_u16_units_v1'
    ]);
  });

  it('algorithm_version 固定为 lf-text-v1@cc9e40d', async () => {
    const rows = await runSql(db, '耳机');
    assert.ok(rows.length > 0);
    for (const r of rows) assert.equal(r.algorithm_version, 'lf-text-v1@cc9e40d');
  });

  /* ------------------------------------------------------------------
   * 1) 全量顺序/分数/分级一致（emoji 相邻的两条也在里面）
   * ------------------------------------------------------------------ */
  const parityQueries = [
    ['耳机', [], 'query=耳机'],
    ['黑色耳机', ['耳机', '黑色'], 'query=黑色耳机 + 两个关键词'],
    ['证件卡', [], 'query=证件卡'],
    ['写有名字的证件卡', [], 'query=写有名字的证件卡（隐藏细节命中）'],
    ['钥匙', [], 'query=钥匙（中文括号）'],
    ['iphone', [], 'query=iphone（大小写）'],
    ['书包', ['背包'], 'query=书包 + 同义词关键词'],
    ['黑色水杯', [], 'query=黑色水杯（sec=0 对照）'],
    ['张三丰', [], 'query=张三丰（防猜：base 不达标）'],
    ['雨伞', [], 'query=雨伞（同分两条）'],
    ['aa', [], 'query=aa'],
    ['bb', ['bb'], 'query=bb + 重复关键词（分数 > 1）'],
    ['😀', [], 'query=😀（纯 emoji）'],
    ['杯子😀', [], 'query=杯子😀（emoji 与汉字相邻，须与 JS 等价）'],
    ['杯', [], 'query=杯（单字，ngram 退化为整串）'],
    ['完全不存在的物品', ['乱七八糟'], 'query=无命中']
  ];

  for (const [q, kws, name] of parityQueries) {
    it(`结果一致 · ${name}`, async () => {
      const jsRows = runLegacy(legacy, CORPUS, q, kws);
      const sqlRows = await runSql(db, q, kws);
      assertParity(jsRows, sqlRows, name);
      console.log(`  [一致] ${name}\n         JS : ${fmt(jsRows)}\n         SQL: ${fmt(sqlRows)}`);
    });
  }

  /* ------------------------------------------------------------------
   * 2) title=aa、query=aa -> 1.15（用户点名的用例）
   * ------------------------------------------------------------------ */
  it('title=aa、query=aa 得分恰好 1.15', async () => {
    const sqlRows = await runSql(db, 'aa');
    const hit = sqlRows.find((r) => r.id === 101);
    assert.ok(hit, 'LF-101 应该在结果里');
    assert.equal(hit.score, 1.15);
    assert.equal(hit.level, 'high');
    assert.equal(hit.label, '很可能就是它 · 115%');
    const jsHit = runLegacy(legacy, CORPUS, 'aa').find((r) => r.id === 101);
    assert.equal(jsHit.score, 1.15);
  });

  /* ------------------------------------------------------------------
   * 3) 重复关键词逐次计分 + 封顶 0.3
   * ------------------------------------------------------------------ */
  it('重复关键词按次数累加，且 bonus 封顶 0.3', async () => {
    const base = await baseOf(db, 102, '黑色', ['耳机', '耳机']);

    // 两个相同关键词 + 标题奖励 0.15 => 0.05*2 + 0.15 = 0.25，未封顶
    const r2 = (await runSql(db, '黑色', ['耳机', '耳机'])).find((r) => r.id === 102);
    assert.ok(r2, 'LF-102 应该在结果里');
    assert.ok(Math.abs(r2.score - (base + 0.25)) <= TOL,
      `期望 base+0.25，实际 ${r2.score}（base=${base}）`);

    // 四个关键词 + 标题奖励 => 0.35，被 Math.min(...,0.3) 封顶
    // （关键词本身也进 qExpanded，所以 base 要按 4 个关键词重算）
    const base4 = await baseOf(db, 102, '黑色', ['耳机', '耳机', '黑色', '黑色']);
    const r4 = (await runSql(db, '黑色', ['耳机', '耳机', '黑色', '黑色'])).find((r) => r.id === 102);
    assert.ok(Math.abs(r4.score - (base4 + 0.3)) <= TOL,
      `期望 base4+0.3（封顶），实际 ${r4.score}（base4=${base4}）`);

    // 与历史 JS 完全一致
    const js2 = runLegacy(legacy, CORPUS, '黑色', ['耳机', '耳机']).find((r) => r.id === 102);
    const js4 = runLegacy(legacy, CORPUS, '黑色', ['耳机', '耳机', '黑色', '黑色']).find((r) => r.id === 102);
    assert.ok(Math.abs(js2.score - r2.score) <= TOL);
    assert.ok(Math.abs(js4.score - r4.score) <= TOL);
    console.log(`  [重复关键词] 2 次=${r2.score.toFixed(4)}  4 次(封顶)=${r4.score.toFixed(4)}  base=${base.toFixed(4)}`);
  });

  /* ------------------------------------------------------------------
   * 4) 隐藏细节加分门槛
   * ------------------------------------------------------------------ */
  it('隐藏细节：sec>0.1 且 base>0.05 才加分', async () => {
    const sqlRows = await runSql(db, '写有名字的证件卡');
    const hit = sqlRows.find((r) => r.id === 103);
    assert.ok(hit, 'LF-103 应当在结果里');

    const base = await baseOf(db, 103, '写有名字的证件卡');
    const sec = Number((await db.query('SELECT lf_dice_v1($1,$2) AS v', [
      '写有名字的证件卡', '学生证上面名字是：格里菲斯'
    ])).rows[0].v);

    assert.ok(sec > 0.1, `sec 应超过 0.1 门槛，实际 ${sec}`);
    assert.ok(base > 0.05, `base 应超过 0.05 门槛，实际 ${base}`);
    // score = base + min(bonus,0.3) + sec*0.9，且 min(1, ...) 封顶（本用例无关键词，标题不含 query -> bonus=0）
    const expect = Math.min(1, base + sec * 0.9);
    assert.ok(Math.abs(hit.score - expect) <= TOL, `期望 ${expect}，实际 ${hit.score}`);

    // 门槛 1：sec 为 0 -> 完全不触发私有信号
    const r115 = (await runSql(db, '黑色水杯')).find((r) => r.id === 115);
    const base115 = await baseOf(db, 115, '黑色水杯');
    const sec115 = Number((await db.query('SELECT lf_dice_v1($1,$2) AS v', [
      '黑色水杯', '杯底贴了一张星星贴纸'
    ])).rows[0].v);
    assert.equal(sec115, 0, 'LF-115 的 detail 与 query 无 2-gram 交集');
    assert.ok(Math.abs(r115.score - base115) <= TOL, `sec=0 时不应加分：${r115.score} vs ${base115}`);

    // 门槛 2：base 不达标 -> 即使 detail 高度吻合也不许加分（防猜）
    const r116 = (await runSql(db, '张三丰')).find((r) => r.id === 116);
    assert.equal(r116, undefined, 'base<=0.05 时 LF-116 不应进入结果（score 被压到 0.08 以下）');
    console.log(`  [隐藏细节] LF-103 base=${base.toFixed(4)} sec=${sec.toFixed(4)} score=${hit.score.toFixed(4)}`);
  });

  /* ------------------------------------------------------------------
   * 5) returned / claimed
   * ------------------------------------------------------------------ */
  it('returned 剔除、claimed 保留、两种 post_type 都参与', async () => {
    const rows = await runSql(db, '耳机');
    const ids = rows.map((r) => r.id);
    assert.ok(!ids.includes(104), 'returned 的 LF-104 必须被剔除');
    assert.ok(ids.includes(105), 'claimed 的 LF-105 必须保留');
    assert.ok(ids.includes(113), 'post_type=lost 的 LF-113 必须参与');
    assert.ok(ids.includes(102), 'post_type=found 的 LF-102 必须参与');
    // SQL 侧逐行核对状态，防止"返回了却标错"
    for (const r of rows) assert.notEqual(r.status, 'returned');
  });

  /* ------------------------------------------------------------------
   * 6) 同分排序：规格新增的确定性规则，JS 侧同序对照
   * ------------------------------------------------------------------ */
  it('同分按 created_at DESC, id DESC（新增的确定性规则，两侧同序）', async () => {
    const rows = await runSql(db, '蓝色·雨伞');
    const a = rows.findIndex((r) => r.id === 106);
    const b = rows.findIndex((r) => r.id === 107);
    assert.ok(a >= 0 && b >= 0, '两条同分记录都应在结果里');
    assert.ok(b < a, '同分同时间时 id 大的（107）排在前面');
    assert.ok(Math.abs(rows[a].score - rows[b].score) <= TOL, '两条分数应完全相同');
    assert.equal(rows[b].rank, b + 1);

    // 历史 JS 侧：喂进去的候选顺序已按 created_at DESC, id DESC 排好，
    // Array.prototype.sort 稳定 → 同分保持入参顺序，结果与 SQL 一致。
    const jsRows = runLegacy(legacy, CORPUS, '蓝色·雨伞');
    const ja = jsRows.findIndex((r) => r.id === 106);
    const jb = jsRows.findIndex((r) => r.id === 107);
    assert.ok(jb < ja, 'JS 侧同分顺序也应是 107 在 106 之前');
    assert.deepEqual(jsRows.map((r) => r.id), rows.map((r) => r.id));

    // 候选顺序本身就是 created_at DESC, id DESC（legacyCandidates 的职责）
    const cands = legacyCandidates(CORPUS, 1000).map((x) => x.id);
    const idx106 = cands.indexOf(106);
    const idx107 = cands.indexOf(107);
    assert.ok(idx107 < idx106, '入参候选顺序：107 应在 106 之前');
  });

  /* ------------------------------------------------------------------
   * 7) 中文标点与大小写
   * ------------------------------------------------------------------ */
  it('中文标点被清洗、大小写按历史语义处理', async () => {
    // 中文括号：title「钥匙（宿舍）」不因括号而与 query「钥匙」失配
    const keyRows = await runSql(db, '钥匙');
    assert.ok(keyRows.some((r) => r.id === 108), 'LF-108 应命中');
    // 正则元字符不能穿透成模式：notice 里的 [已过期] 被当作普通字符删掉
    const cardRows = await runSql(db, '证件卡');
    assert.ok(cardRows.some((r) => r.id === 117), 'LF-117 应命中');

    // 大小写：dice 走 lower，命中；title 奖励用 indexOf（区分大小写），不命中
    const ip = (await runSql(db, 'iphone')).find((r) => r.id === 109);
    const base = await baseOf(db, 109, 'iphone');
    assert.ok(ip, 'LF-109 应命中（大小写不影响 dice）');
    assert.ok(Math.abs(ip.score - base) <= TOL, `大小写不同不应给 0.15 标题奖励：${ip.score} vs ${base}`);
    assert.ok(ip.score < base + 0.15);
    console.log(`  [大小写] iphone 命中，score=${ip.score.toFixed(4)}（无 0.15 标题奖励，与历史 JS 一致）`);
  });

  it('输入只 trim：首尾空白不改变结果，也不丢 0.15 标题奖励', async () => {
    // title 奖励走 indexOf，首尾空格会让它悄悄失效——所以函数内先 btrim。
    // 这也是「两端同一句原始输入结果一致」的前提：网页 trim、函数也 trim。
    const plain = await runSql(db, 'aa');
    const padded = await runSql(db, '\t  aa  \n');
    const sig = (rows) => rows.map((r) => [r.id, Number(r.score), r.rank, r.level, r.label]);
    assert.deepEqual(sig(padded), sig(plain), '首尾空白不得改变编号/分数/顺序/分级');
    const hit = plain.find((r) => r.id === 101) || plain[0];
    assert.ok(hit, 'aa 应命中');
    assert.ok(Math.abs(Number(hit.score) - 1.15) <= TOL, `应保留 1.15 标题奖励，实际 ${hit && hit.score}`);
    console.log(`  [trim] 'aa' 与 '\t  aa  \n' 结果相同，score=${Number(hit.score).toFixed(4)}`);
  });

  /* ------------------------------------------------------------------
   * 8) 候选池：先取最新 1000 条，再排除 returned
   * ------------------------------------------------------------------ */
  it('候选池 = 最新 1000 条（先截断再剔除 returned）', async () => {
    const db2 = new PGlite();
    try {
      await db2.exec(fs.readFileSync(SCHEMA, 'utf8'));
      await db2.exec(fs.readFileSync(MIGRATION, 'utf8'));

      // 5 条最老的完美匹配（title=zz）
      await db2.query(
        `INSERT INTO lost_items (id, title, status, post_type, created_at)
         OVERRIDING SYSTEM VALUE
         SELECT 9000 + g, 'zz', 'open', 'found', timestamptz '2020-01-01 00:00:00+00'
           FROM generate_series(1, 5) AS g`
      );
      // 1000 条更新的无关记录
      await db2.query(
        `INSERT INTO lost_items (id, title, status, post_type, created_at)
         OVERRIDING SYSTEM VALUE
         SELECT 9100 + g, '普通记录' || g, 'open', 'found',
                timestamptz '2026-11-01 00:00:00+00' + (g || ' minutes')::interval
           FROM generate_series(1, 1000) AS g`
      );

      const sqlRows = await runSql(db2, 'zz');
      assert.equal(sqlRows.length, 0, '最老的 5 条被 1000 条上限截断，不应出现');

      const all = await db2.query('SELECT id, title, status, post_type, created_at FROM lost_items');
      const rows = all.rows.map((r) => ({
        id: Number(r.id), title: r.title, status: r.status, postType: r.post_type,
        created: new Date(r.created_at).toISOString()
      }));

      const capped = legacyCandidates(rows, 1000);
      assert.ok(!capped.some((r) => r.title === 'zz'), 'JS 侧按 1000 条截断后同样不应出现');
      assert.equal(runLegacy(legacy, rows, 'zz', [], 1000).length, 0);

      // 不截断时它本来能拿 1.15 —— 证明被隐藏的是"截断"，不是"没匹配上"
      const uncapped = runLegacy(legacy, rows, 'zz', [], rows.length);
      assert.ok(uncapped.length >= 5);
      assert.equal(uncapped[0].score, 1.15);
      console.log(`  [候选池] 截断后 SQL=0 条 / JS=0 条；不截断时 JS 命中 ${uncapped.length} 条，最高 ${uncapped[0].score}`);
    } finally {
      await db2.close();
    }
  });

  /* ------------------------------------------------------------------
   * 9) 私有字段不外泄
   * ------------------------------------------------------------------ */
  it('返回列不含 detail / location / ai_desc / ai_tags', async () => {
    const res = await db.query('SELECT * FROM public.lf_search_text_v1($1,$2::text[],$3::int)',
      ['证件卡', [], 20]);
    assert.ok(res.rows.length > 0);
    const cols = Object.keys(res.rows[0]).sort();
    assert.deepEqual(cols, [
      'algorithm_version', 'category', 'color_tone', 'id', 'label',
      'level', 'notice', 'pickup_location', 'post_type', 'pub_time',
      'rank', 'score', 'status', 'title'
    ]);
    const blob = JSON.stringify(res.rows);
    for (const r of CORPUS) {
      if (r.detail) assert.ok(!blob.includes(r.detail), `detail 内容泄漏：${r.detail}`);
      if (r.location) assert.ok(!blob.includes(r.location), `location 内容泄漏：${r.location}`);
    }
  });

  /* ------------------------------------------------------------------
   * 10) 空输入 / 边界参数
   * ------------------------------------------------------------------ */
  it('空 query、空关键词、limit=0 不报错且行为与 JS 一致', async () => {
    assert.deepEqual(await runSql(db, ''), []);
    assert.deepEqual(await runSql(db, '', []), []);
    assert.deepEqual(await runSql(db, '耳机', [], 0), []);
    const jsRows = runLegacy(legacy, CORPUS, '');
    assert.equal(jsRows.length, 0, '历史 JS 对空 query 也返回空');
    // limit 上限被夹到 200，不因大数拖库
    const many = await runSql(db, '记录', [], 99999);
    assert.ok(many.length <= 200);
  });
});

/* ====================================================================
 * emoji：n-gram 按 UTF-16 code unit 切分，必须与 JS 完全等价
 * ==================================================================== */
describe('emoji：SQL 的 UTF-16 code unit 切分与 JS 等价', () => {
  let db;
  const EMOJI_CORPUS = CORPUS.filter((r) => [110, 111, 112].includes(r.id));

  before(async () => {
    db = new PGlite();
    await db.exec(fs.readFileSync(SCHEMA, 'utf8'));
    await db.exec(fs.readFileSync(MIGRATION, 'utf8'));
    await seed(db, EMOJI_CORPUS);
  });
  after(async () => { await db.close(); });

  it('lf_u16_units_v1 与 JS string.length 对齐（星平面字符拆成代理对）', async () => {
    const res = await db.query(
      `SELECT public.lf_u16_units_v1('😀') AS one,
              public.lf_u16_units_v1('杯子😀') AS mix,
              public.lf_u16_units_v1('杯子😀x') AS mix2,
              public.lf_u16_units_v1('') AS empty,
              public.lf_u16_units_v1('a') AS single`
    );
    const r = res.rows[0];
    assert.deepEqual(r.one, [0xD83D, 0xDE00]);
    assert.deepEqual(r.mix, [0x676F, 0x5B50, 0xD83D, 0xDE00]);
    assert.deepEqual(r.mix2, [0x676F, 0x5B50, 0xD83D, 0xDE00, 0x78]);
    assert.deepEqual(r.empty, []);
    assert.deepEqual(r.single, [0x61]);

    // 与 JS 逐一对齐
    for (const s of ['😀', '杯子😀', '杯子😀x', '', 'a', '👨‍👩‍👧']) {
      const jsLen = s.length;                                  // UTF-16 code unit 数
      const sqlLen = Number((await db.query(
        'SELECT coalesce(array_length(public.lf_u16_units_v1($1),1),0) AS n', [s]
      )).rows[0].n);
      assert.equal(sqlLen, jsLen, `长度不一致：${JSON.stringify(s)}`);
    }
  });

  it('2-gram 数量与 JS 一致（含劈开代理对的那几个 gram）', async () => {
    // JS：'杯子😀' 长度 4 → 3 个 gram：杯子 / 子·高代理 / 高代理·低代理
    const res = await db.query(
      "SELECT public.lf_bigrams_v1('杯子😀') AS g, public.lf_bigrams_v1('😀') AS e"
    );
    const grams = res.rows[0].g.slice().sort();
    assert.deepEqual(grams, ['5B50D83D', '676F5B50', 'D83DDE00'].sort());
    assert.deepEqual(res.rows[0].e, ['D83DDE00']);

    // 与 JS Set 的大小逐个对齐（hex 与字符串一一对应，数量必须相同）
    const jsSet = (s) => {
      const t = s.toLowerCase().replace(/[\s，。,.!?！？、；;：:"'（）()【】\[\]]/g, '');
      const set = new Set();
      if (t.length < 2) { if (t) set.add(t); return set; }
      for (let i = 0; i <= t.length - 2; i++) set.add(t.slice(i, i + 2));
      return set;
    };
    for (const s of ['杯子😀', '😀', '杯子😀x', 'a', '']) {
      const js = jsSet(s).size;
      const sql = Number((await db.query(
        'SELECT coalesce(array_length(public.lf_bigrams_v1($1),1),0) AS n', [s]
      )).rows[0].n);
      assert.equal(sql, js, `gram 数量不一致：${JSON.stringify(s)} JS=${js} SQL=${sql}`);
    }
  });

  it('纯 emoji 记录两侧完全一致（1.15）', async () => {
    const jsRows = runLegacy(legacy, EMOJI_CORPUS, '😀');
    const sqlRows = await runSql(db, '😀');
    assertParity(jsRows, sqlRows, 'emoji 纯 emoji');
    const sql110 = sqlRows.find((r) => r.id === 110);
    assert.equal(sql110.score, 1.15);
    console.log(`  [emoji] 纯 emoji LF-110  JS/SQL 均 ${sql110.score.toFixed(4)}`);
  });

  it('emoji 与汉字相邻：不再是"已知差异"，逐分等价', async () => {
    const jsRows = runLegacy(legacy, EMOJI_CORPUS, '😀');
    const sqlRows = await runSql(db, '😀');
    assertParity(jsRows, sqlRows, 'emoji 相邻');

    const js111 = jsRows.find((r) => r.id === 111);
    const sql111 = sqlRows.find((r) => r.id === 111);
    assert.ok(js111 && sql111, 'LF-111 两侧都应命中');
    // 历史 JS：'杯子😀' 切出 [子·高代理] [高代理·低代理]，后者恰好等于整个 emoji
    // → base = 2*1/(1+11) = 0.1667，加标题奖励 0.15 = 0.3167。
    // 修正前 SQL 按码点切分不产生孤立 emoji gram，只能拿 0.15 —— 这就是本轮修掉的反例。
    assert.ok(Math.abs(sql111.score - js111.score) <= TOL,
      `LF-111 分数不一致 JS=${js111.score} SQL=${sql111.score}`);
    assert.ok(Math.abs(sql111.score - 0.3167) < 1e-3, `LF-111 应约 0.3167，实际 ${sql111.score}`);
    console.log(`  [emoji] LF-111「杯子😀」  JS=${js111.score.toFixed(4)}  SQL=${sql111.score.toFixed(4)}  等价`);
  });

  it('emoji 紧邻拉丁字母（杯子😀x）同样等价', async () => {
    const jsRows = runLegacy(legacy, EMOJI_CORPUS, '😀x');
    const sqlRows = await runSql(db, '😀x');
    assertParity(jsRows, sqlRows, 'emoji + 拉丁');
    const js112 = jsRows.find((r) => r.id === 112);
    const sql112 = sqlRows.find((r) => r.id === 112);
    assert.ok(js112 && sql112);
    console.log(`  [emoji] LF-112「杯子😀x」  JS=${js112.score.toFixed(4)}  SQL=${sql112.score.toFixed(4)}  等价`);
  });
});

describe('字典快照差异（历史版本 vs 现行枚举）', () => {
  let db;

  before(async () => {
    db = new PGlite();
    await db.exec(fs.readFileSync(SCHEMA, 'utf8'));
    await db.exec(fs.readFileSync(MIGRATION, 'utf8'));
  });
  after(async () => { await db.close(); });

  it('wallet / glasses / brown / purple / clear 在 v1 字典里没有 label', async () => {
    const res = await db.query(
      `SELECT lf_category_label_v1('wallet') AS w, lf_category_label_v1('glasses') AS g,
              lf_color_label_v1('brown') AS b, lf_color_label_v1('purple') AS p,
              lf_color_label_v1('clear') AS c, lf_category_label_v1('headphones') AS h`
    );
    assert.deepEqual(res.rows[0], { w: '', g: '', b: '', p: '', c: '', h: '耳机' });
  });
});
