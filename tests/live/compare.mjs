/**
 * tests/live/compare.mjs —— 网页侧结果 vs SQL 工具结果，逐项比对
 *
 * 为什么要两个通道：
 *   - 网页侧（rpc_smoke.mjs）走 SDK + api.js → 网关 → rpc，证明「浏览器这条路」通；
 *   - SQL 工具（workbuddy_cloudservice_db_exec_sql，管理员身份）直接 SELECT 函数，
 *     证明「库里这条路」通。
 *   两边同输入必须给出同编号 / 同分数 / 同顺序 / 同分级 / 同 label。
 *   只有两者都对得上，才说明网关没有悄悄改写参数或结果。
 *
 * 用法：
 *   node tests/live/compare.mjs tests/live/out/live-result.json tests/live/out/sql-result.json
 *
 * sql-result.json 的内容就是 SQL 工具返回的那段 JSON（整体原样存下来即可，
 * 脚本会自动剥掉 `[{"json_agg": "..."}]` 这种外壳）。
 */
import fs from 'node:fs';

const TOL = 1e-12;

function unwrap(raw) {
  let v = raw;
  // [{"json_agg": "[...]"}]
  if (Array.isArray(v) && v.length === 1 && v[0] && typeof v[0] === 'object') {
    const keys = Object.keys(v[0]);
    if (keys.length === 1) {
      let inner = v[0][keys[0]];
      if (typeof inner === 'string') {
        try { inner = JSON.parse(inner); } catch { /* 原样返回下面会报错 */ }
      }
      return inner;
    }
  }
  // {"cases": [...]}
  if (v && typeof v === 'object' && Array.isArray(v.cases)) return v;
  return v;
}

function loadCases(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const v = unwrap(raw);
  if (!v || !Array.isArray(v.cases)) {
    throw new Error(`${file} 里找不到 cases 数组（拿到的是 ${JSON.stringify(v).slice(0, 120)}）`);
  }
  return v.cases;
}

const [, , livePath, sqlPath] = process.argv;
if (!livePath || !sqlPath) {
  console.error('用法：node tests/live/compare.mjs <live-result.json> <sql-result.json>');
  process.exit(2);
}

const live = loadCases(livePath);
const sql = loadCases(sqlPath);
let fails = 0;

function check(name, ok, detail) {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) fails++;
}

check('两侧用例数一致', live.length === sql.length, `网页 ${live.length} / SQL ${sql.length}`);

for (let i = 0; i < Math.min(live.length, sql.length); i++) {
  const a = live[i];
  const b = sql[i];
  const tag = `query=${JSON.stringify(a.query)}`;

  check(`用例对齐 ${tag}`, a.query === b.query, a.query === b.query ? '' : `SQL 侧是 ${JSON.stringify(b.query)}`);
  check(`行数一致 ${tag}`, a.rows.length === b.rows.length, `网页 ${a.rows.length} / SQL ${b.rows.length}`);

  const ids = (x) => x.rows.map((r) => Number(r.id));
  check(`编号与顺序一致 ${tag}`, JSON.stringify(ids(a)) === JSON.stringify(ids(b)),
    `${JSON.stringify(ids(a))} vs ${JSON.stringify(ids(b))}`);

  const scoreDiff = a.rows.map((r, k) => Math.abs(Number(r.score) - Number((b.rows[k] || {}).score)));
  check(`分数逐项相同（|Δ|<=${TOL}） ${tag}`,
    scoreDiff.length === b.rows.length && scoreDiff.every((d) => Number.isFinite(d) && d <= TOL),
    `最大误差 ${scoreDiff.length ? Math.max(...scoreDiff).toExponential(2) : 'n/a'}`);

  const fieldEq = (f) => a.rows.every((r, k) => String(r[f]) === String((b.rows[k] || {})[f]));
  check(`rank 一致 ${tag}`, fieldEq('rank'), '');
  check(`level 一致 ${tag}`, fieldEq('level'), '');
  check(`label 一致 ${tag}`, fieldEq('label'), '');

  // 精确值打出来，方便人工扫一眼
  const fmt = (rows) => rows.map((r) => `#${r.id} ${Number(r.score).toFixed(6)} ${r.level} r${r.rank}`).join(' | ') || '(空)';
  console.log(`  网页：${fmt(a.rows)}`);
  console.log(`  SQL ：${fmt(b.rows)}`);
}

console.log(`\n${fails ? `❌ ${fails} 项不一致` : '✅ 两侧完全一致（编号/顺序/分数/rank/level/label）'}`);
process.exit(fails ? 1 : 0);
