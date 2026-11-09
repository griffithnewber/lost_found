/**
 * tests/live/rpc_smoke.mjs —— 真·联调（对着**测试应用**跑，不碰生产）
 *
 * 与上一版的区别（上一版只能证明「网关通」）：
 *   1. 先往测试库写一批**已知的合成记录**，再断言预期编号 / 分数 / 顺序；
 *      空数组再也蒙不过去（每个正向用例都有 minRows + mustInclude）。
 *   2. 调用链走**网页真正用的代码**：CDN 上的 WorkBuddyCloud SDK + assets/api.js
 *      的 LF.api.searchItems()，不是手搓 fetch。
 *   3. 期望值不是硬编码，而是由历史 JS（cc9e40d 的 search.js/match.js）现算 ——
 *      这才是「SQL 函数 == 原算法」的独立证据。
 *   4. 错误路径同时看 HTTP 状态与**错误码**（PGRST202 等），并断言
 *      searchItems 把它们判成 ok:false，而不是 rows: []。
 *   5. 结果落盘 tests/live/out/live-result.json，供 compare.mjs 与
 *      SQL 工具（workbuddy_cloudservice_db_exec_sql）的返回逐项比对。
 *
 * 用法：
 *   1. 仓库根 .env.test（已 gitignore）：
 *        WB_TEST_ENDPOINT=https://<测试应用>.app.workbuddy.host
 *        WB_TEST_KEY=wbpk_<测试应用的公开密钥>
 *   2. node tests/live/rpc_smoke.mjs
 *      可选 --keep 保留种子数据（默认跑完删除）
 *
 * 安全护栏：endpoint 命中生产域名直接拒绝运行（除非 --allow-prod-readonly，
 * 那种模式只做只读探测，不写入、不删数据）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createAppEnv, ROOT } from './sdk_harness.mjs';
import { SEED, SEED_MARK, CASES, toCorpus } from './fixtures.mjs';
import { loadLegacyJs } from '../lib/legacy.mjs';
import { runLegacy } from '../lib/corpus.mjs';

const PROD_HOST = 'lost-found-56662.app.workbuddy.host';
const OUT_DIR = path.join(ROOT, 'tests', 'live', 'out');
const OUT_FILE = path.join(OUT_DIR, 'live-result.json');
const TOL = 1e-9;

function loadEnv() {
  const p = path.join(ROOT, '.env.test');
  if (!fs.existsSync(p)) {
    console.error('缺少 .env.test（WB_TEST_ENDPOINT / WB_TEST_KEY），见文件头说明');
    process.exit(2);
  }
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = loadEnv();
const endpoint = (env.WB_TEST_ENDPOINT || '').replace(/\/$/, '');
const key = env.WB_TEST_KEY || '';
const keep = process.argv.includes('--keep');
const allowProd = process.argv.includes('--allow-prod-readonly');

if (!endpoint || !key) {
  console.error('.env.test 里缺 WB_TEST_ENDPOINT 或 WB_TEST_KEY');
  process.exit(2);
}
const isProd = endpoint.includes(PROD_HOST);
if (isProd && !allowProd) {
  console.error(`拒绝运行：${endpoint} 是生产应用。测试库请用独立 applicationId；`);
  console.error('确实只想做只读探测时，显式加 --allow-prod-readonly。');
  process.exit(2);
}

const REST = `${endpoint}/.cloud/database/rest`;
const H = { 'x-wb-webapp-access-key': key, 'Content-Type': 'application/json' };

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

async function rest(pathname, init = {}) {
  const res = await fetch(REST + pathname, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

function canonical(rows) {
  return (rows || [])
    .map((r) => `#${r.item ? r.item.id : r.id} ${Number(r.score).toFixed(4)} ${r.level}`)
    .join(' | ') || '(空)';
}

/* ---------------- 1. 清场 ---------------- */
async function cleanup() {
  const del = await rest(`/lost_items?owner_id=eq.${SEED_MARK}`, { method: 'DELETE' });
  return del.status;
}

/* ---------------- 2. 写入种子 ---------------- */
async function seed() {
  const inserted = [];
  for (const row of SEED) {
    const res = await rest('/lost_items?select=id', {
      method: 'POST',
      headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify({
        title: row.title,
        detail: row.detail,
        location: row.detail ? '测试地点（不公开）' : null,
        notice: row.notice,
        category: row.category,
        color_tone: row.colorTone,
        ai_tags: row.aiTags,
        status: row.status,
        post_type: row.postType,
        created_at: row.created,
        owner_id: SEED_MARK,
        pub_time: row.created.replace('T', ' ').replace('Z', '')
      })
    });
    if (res.status !== 201 || !Array.isArray(res.body) || !res.body[0]) {
      throw new Error(`写入种子失败（${row.key}）：HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    }
    inserted.push({ ...row, id: Number(res.body[0].id) });
  }
  return inserted;
}

/* ---------------- 3. 用历史 JS 算期望 ---------------- */
function expectedFor(legacy, corpus, c) {
  // 与 api.searchItems 完全相同的入参：只 trim、keywords 固定 []
  const rows = runLegacy(legacy, corpus, c.query.trim(), []);
  return rows.slice(0, c.limit);
}

/* ---------------- 4. 错误路径 ---------------- */
async function checkErrorPaths() {
  // (a) 不存在的函数：HTTP 404 + 错误码 PGRST202（不是空数组）
  const missing = await rest('/rpc/lf_probe_not_exist', {
    method: 'POST', body: JSON.stringify({ p_query: 'x' })
  });
  // 实测：网关的 code 是 DATABASE_PGRST202（带命名空间前缀），不是裸 PGRST202。
  // api.js 用 /PGRST202/ 做包含匹配正是为了兼容这种前缀 —— 这里把**实际值**也记下来。
  record(
    '函数缺失：HTTP 404 且 code 含 PGRST202',
    missing.status === 404 && missing.body && /PGRST202/.test(String(missing.body.code || '')),
    `HTTP ${missing.status} code=${missing.body && missing.body.code} ${JSON.stringify(missing.body).slice(0, 120)}`
  );

  // (b) 同一条错误走 SDK：确认 SDK 把 code 原样带出来（api.js 正是靠它判 rpc_missing）
  const good = await createAppEnv({ endpoint, key });
  const client = good.LF.api.getCloud();      // 与 api.js 内部同一个客户端实例
  let sdkErr = null;
  try {
    const r = await client.database.rpc('lf_probe_not_exist', { p_query: 'x' });
    sdkErr = r && r.error;
  } catch (e) {
    sdkErr = e;
  }
  record(
    'SDK rpc 把 PGRST202 原样带出（api.js 据此判 rpc_missing）',
    !!sdkErr && /PGRST202/.test(String(sdkErr.code || '')),
    `code=${sdkErr && sdkErr.code} message=${String((sdkErr && sdkErr.message) || '').slice(0, 90)}`
  );

  // (c) 密钥错误：searchItems 必须 ok:false，不能是 rows:[]
  const badKey = await createAppEnv({ endpoint, key: 'wbpk_invalid_probe_' + Date.now() });
  const badKeyRes = await badKey.LF.api.searchItems('耳机', [], 3);
  record(
    '密钥错误 → searchItems 返回 ok:false（不是「没有匹配」）',
    badKeyRes.ok === false && badKeyRes.rows === undefined,
    `code=${badKeyRes.code} error=${String(badKeyRes.error || '').slice(0, 80)}`
  );

  // (d) 网络失败：端点不可达，同样必须是失败
  const offline = await createAppEnv({ endpoint: 'https://127.0.0.1:9', key });
  const offRes = await offline.LF.api.searchItems('耳机', [], 3);
  record(
    '端点不可达 → searchItems 返回 ok:false（不是「没有匹配」）',
    offRes.ok === false && offRes.rows === undefined,
    `code=${offRes.code} error=${String(offRes.error || '').slice(0, 80)}`
  );
}

/* ---------------- 5. 隐私列 ---------------- */
async function checkPrivacy() {
  // 实测：列权限被拒时网关给 401（anon 在 PostgREST 里是 no-privilege 角色），不是 403。
  // 所以判定用「401/403 + 响应体含 permission denied」，而不是写死某个状态码。
  const denied = (r) => (r.status === 401 || r.status === 403) &&
    /permission denied/i.test(JSON.stringify(r.body || ''));
  const detail = await rest('/lost_items?select=detail&limit=1');
  record('浏览器身份读不到 detail（401/403 且 permission denied）',
    denied(detail), `HTTP ${detail.status} ${JSON.stringify(detail.body).slice(0, 100)}`);

  const pub = await rest('/lost_items?select=id,title,status,pickup_location&limit=1');
  record('公开列仍可读', pub.status === 200, `HTTP ${pub.status}`);

  const retAll = await rest('/lost_items', {
    method: 'POST',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify({ title: 'LFTEST·RETURNING', status: 'open', post_type: 'found' })
  });
  record('RETURNING *（不指定列）被拒（api.js 必须显式 select）',
    denied(retAll), `HTTP ${retAll.status} ${JSON.stringify(retAll.body).slice(0, 100)}`);
}

/* ---------------- main ---------------- */
async function main() {
  console.log(`\n目标：${endpoint}`);
  console.log(`SDK：${(await createAppEnv({ endpoint, key })).sdkFile}\n`);

  if (!isProd) await cleanup();

  let seeded = [];
  const casesOut = [];
  try {
    // 写种子
    seeded = await seed();
    record('写入合成种子记录', true, `${seeded.length} 条：${seeded.map((s) => `#${s.id}`).join(' ')}`);

    // 候选池必须只含种子：否则「顺序/分数」不可控，测试就是自欺
    const all = await rest('/lost_items?select=id&limit=1001');
    const total = Array.isArray(all.body) ? all.body.length : -1;
    record(
      '测试库只含本次种子（候选池可控）',
      total === seeded.length,
      `库里 ${total} 条 / 种子 ${seeded.length} 条${total !== seeded.length ? '（测试库请用全新应用，或先清空）' : ''}`
    );

    const legacy = loadLegacyJs();
    const corpus = toCorpus(seeded);
    const byId = new Map(seeded.map((s) => [s.id, s]));

    // 真实调用链：SDK + LF.api.searchItems
    const app = await createAppEnv({ endpoint, key });

    const seenByQuery = new Map();

    for (const c of CASES) {
      // 两参数签名：p_keywords 由 api.js 固定成 []，这里传不进去
      const res = await app.LF.api.searchItems(c.query, c.limit);
      const label = `query=${JSON.stringify(c.query)}`;

      if (!res.ok) {
        record(`searchItems 调用成功 ${label}`, false, `code=${res.code} ${res.error}`);
        continue;
      }
      record(`searchItems 调用成功 ${label}`, true, `${res.rows.length} 条：${canonical(res.rows)}`);

      const rows = res.rows.map((r) => ({
        id: r.item.id,
        score: r.score,
        rank: r.rank,
        level: r.level,
        label: r.label,
        algorithm_version: r.algorithmVersion
      }));

      // 正向用例不能是空数组蒙过去
      const ids = rows.map((r) => r.id);
      const need = c.mustInclude.map((k) => seeded.find((s) => s.key === k).id);
      record(
        `结果非空且含预期记录 ${label}`,
        rows.length >= c.minRows && need.every((id) => ids.includes(id)),
        `实际 id=${JSON.stringify(ids)} 期望至少含 ${JSON.stringify(need)}`
      );

      // rank 必须是 1..n 连续（函数自己算的，不是前端序号）
      record(
        `rank 连续 1..n ${label}`,
        rows.every((r, i) => r.rank === i + 1),
        rows.map((r) => r.rank).join(',')
      );

      // 与历史 JS 逐项比对：顺序 / 分数 / 分级 / 文案
      const exp = expectedFor(legacy, corpus, c);
      const sameIds = JSON.stringify(exp.map((r) => r.id)) === JSON.stringify(ids);
      const sameScore = exp.length === rows.length &&
        exp.every((e, i) => Math.abs(e.score - rows[i].score) <= TOL);
      const sameLevel = exp.length === rows.length &&
        exp.every((e, i) => e.level === rows[i].level);
      const sameLabel = exp.length === rows.length &&
        exp.every((e, i) => e.label === rows[i].label);

      record(
        `与历史 JS 一致（编号/顺序/分数/分级/label）${label}`,
        sameIds && sameScore && sameLevel && sameLabel,
        sameIds && sameScore && sameLevel && sameLabel
          ? '逐条相同'
          : `JS=${JSON.stringify(exp)} SQL=${JSON.stringify(rows)}`
      );

      // 私有字段不许出现在返回列
      const leak = res.rows.some((r) => ['detail', 'location', 'aiDesc', 'aiTags']
        .some((k) => Object.prototype.hasOwnProperty.call(r.item, k)));
      record(`返回列不含私有字段 ${label}`, !leak, leak ? '出现 detail/location/aiDesc/aiTags' : '干净');

      // 编号与标题对得上（防止「分数对但记录错位」）
      const unknown = rows.filter((r) => !byId.has(r.id));
      record(
        `返回编号都来自本次种子 ${label}`,
        unknown.length === 0,
        unknown.length ? `多出 ${JSON.stringify(unknown.map((r) => r.id))}` : '全部命中种子'
      );
      const titleById = new Map(res.rows.map((h) => [h.item.id, h.item.title]));
      record(
        `编号与标题对应 ${label}`,
        rows.every((r) => !byId.has(r.id) || byId.get(r.id).title === titleById.get(r.id)),
        '防止分数对、记录错位'
      );

      // 只 trim 的验收：首尾空白不能改变结果（两端都只 trim）
      if (c.sameAs) {
        const base = seenByQuery.get(c.sameAs);
        record(
          `首尾空白不影响结果 ${label}`,
          !!base && JSON.stringify(base) === JSON.stringify(rows),
          base ? `与 ${JSON.stringify(c.sameAs)} 逐项相同` : `缺少 ${JSON.stringify(c.sameAs)} 的基准结果`
        );
      }
      seenByQuery.set(c.query.trim(), rows);

      casesOut.push({
        query: c.query,
        querySent: c.query.trim(),   // 网页实际发出的 p_query
        keywords: [],                // 网页固定发送的 p_keywords
        limit: c.limit,
        rows
      });
    }

    await checkErrorPaths();
    if (!isProd) await checkPrivacy();

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify({
      endpoint,
      generatedAt: new Date().toISOString(),
      seedMark: SEED_MARK,
      seededIds: seeded.map((s) => s.id),
      cases: casesOut
    }, null, 2));
    console.log(`\n已写出 ${path.relative(ROOT, OUT_FILE)}（供 compare.mjs 与 SQL 工具结果比对）`);
  } finally {
    if (!isProd && !keep) {
      const status = await cleanup();
      console.log(`\n清场：DELETE owner_id=${SEED_MARK} → HTTP ${status}`);
    } else if (keep) {
      console.log('\n--keep：保留种子数据（owner_id=LFTEST_SEED）');
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.name}：${f.detail}`);
  }
  if (isProd) console.log('（--allow-prod-readonly：只读探测，未写入）');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('冒烟脚本异常：', e);
  process.exit(1);
});
