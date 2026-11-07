/**
 * tests/sql/index.test.mjs
 *
 * 目的：评估并验证 db/migrations/2026-11-07_lf_search_index.sql 的索引
 *      是否真的与 lf_search_text_v1 的查询形状对齐。
 *
 * 被测查询（函数里的 cand CTE）：
 *   SELECT ... FROM lost_items ORDER BY created_at DESC, id DESC LIMIT 1000
 *
 * 验证内容：
 *   1. 索引存在，且列/方向/顺序与 ORDER BY 完全一致；
 *   2. 规划器能用它直取前 1000 行，**不需要额外的 Sort 节点**；
 *   3. 索引不改变结果（同样数据，加索引前后取到的 id 序列相同）。
 *
 * 跑法：cd tests && node --test
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const MIGRATION = path.join(ROOT, 'db', 'migrations', '2026-11-07_lf_search_text_v1.sql');
const INDEX_MIG = path.join(ROOT, 'db', 'migrations', '2026-11-07_lf_search_index.sql');
const SCHEMA = path.join(ROOT, 'tests', 'fixtures', 'schema_lost_items.sql');

const CAND_SQL = 'SELECT id FROM public.lost_items ORDER BY created_at DESC, id DESC LIMIT 1000';

/** 从 EXPLAIN (FORMAT JSON) 的结果里抓出节点类型（PGlite 把计划放在 "QUERY PLAN" 列） */
function nodeTypes(rows) {
  const s = JSON.stringify(rows);
  return [...s.matchAll(/"Node Type":\s*"([^"]+)"/g)].map((m) => m[1]);
}

describe('候选池索引 idx_lost_items_created_id_desc', () => {
  let db;

  before(async () => {
    db = new PGlite();
    await db.exec(fs.readFileSync(SCHEMA, 'utf8'));
    await db.exec(fs.readFileSync(MIGRATION, 'utf8'));

    // 3000 条：够让规划器认真考虑索引，又不至于让测试慢
    await db.query(
      `INSERT INTO lost_items (title, status, post_type, created_at)
       SELECT '记录' || g, 'open', 'found',
              timestamptz '2026-01-01 00:00:00+00' + (g || ' minutes')::interval
         FROM generate_series(1, 3000) AS g`
    );
    await db.exec('ANALYZE public.lost_items');
  });

  after(async () => { await db.close(); });

  it('索引存在，且列/方向与 ORDER BY 一致', async () => {
    await db.exec(fs.readFileSync(INDEX_MIG, 'utf8'));
    const res = await db.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname='public' AND tablename='lost_items'
          AND indexname='idx_lost_items_created_id_desc'`
    );
    assert.equal(res.rows.length, 1, '索引应已创建');
    const def = res.rows[0].indexdef;
    assert.match(def, /\(created_at DESC, id DESC\)/, `索引定义不符：${def}`);
  });

  it('迁移可重复执行（IF NOT EXISTS 幂等）', async () => {
    await db.exec(fs.readFileSync(INDEX_MIG, 'utf8'));
    await db.exec(fs.readFileSync(INDEX_MIG, 'utf8'));
    const n = await db.query(
      `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname='idx_lost_items_created_id_desc'`
    );
    assert.equal(n.rows[0].n, 1);
  });

  it('规划器用它直取前 1000 行，且不产生 Sort 节点', async () => {
    // 强制不用 seqscan：证明"索引确实能满足这个 ORDER BY"，
    // 而不是碰巧数据小、规划器选了别的路径
    await db.exec('SET enable_seqscan = off');
    let nodes;
    try {
      const res = await db.query(`EXPLAIN (FORMAT JSON) ${CAND_SQL}`);
      nodes = nodeTypes(res.rows);
    } finally {
      await db.exec('RESET enable_seqscan');
    }
    const flat = JSON.stringify(nodes);
    assert.ok(!nodes.includes('Sort'), `不应再排序，实际计划：${flat}`);
    assert.ok(
      nodes.some((n) => n === 'Index Scan' || n === 'Index Only Scan' || n === 'Bitmap Index Scan'),
      `应为索引扫描，实际计划：${flat}`
    );
    console.log(`  [索引] 计划节点：${nodes.join(' → ')}`);

    // 真实（不强制）的计划也打出来存档
    const natural = await db.query(`EXPLAIN (FORMAT JSON) ${CAND_SQL}`);
    console.log(`  [索引] 未强制时的计划节点：${nodeTypes(natural.rows).join(' → ')}`);
  });

  it('加索引不改变结果：候选序列与无索引时一致', async () => {
    const withIdx = (await db.query(CAND_SQL)).rows.map((r) => Number(r.id));

    await db.exec('DROP INDEX public.idx_lost_items_created_id_desc');
    const withoutIdx = (await db.query(CAND_SQL)).rows.map((r) => Number(r.id));
    await db.exec(fs.readFileSync(INDEX_MIG, 'utf8'));   // 复原，供后续用例

    assert.deepEqual(withIdx, withoutIdx);
    assert.equal(withIdx.length, 1000);
    // ORDER BY created_at DESC, id DESC：最新插入的（id 最大）在最前
    assert.equal(withIdx[0], Math.max(...withIdx));
  });
});
