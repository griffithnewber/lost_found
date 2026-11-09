/**
 * tests/live/probe_search.mjs —— 文字检索真实链路只读诊断
 *
 * 目的：证明「网页那条路」能调到库里的 lf_search_text_v1，
 *      而不是只证明 curl 能打通 REST。
 *
 * 跑的是 assets/config.js + assets/api.js 里的 LF.api.searchItems()，
 * 中间经过 WorkBuddy Cloud SDK 的 database.rpc()（和浏览器完全一致）。
 *
 * 用法：node tests/live/probe_search.mjs
 */
import { createAppEnv } from './sdk_harness.mjs';

const ENDPOINT = 'https://lost-found-56662.app.workbuddy.host';
const KEY = 'wbpk_7WvCzu8yW3N6uppqR8xFUp_LqOna90BvIXCH5ET2FwqGrOebsmhNbAY';

const QUERIES = ['耳机', '充电宝', '蓝色 充电', '黑色蝴蝶', 'Hello Kitty', ''];

function show(tag, res) {
  if (!res.ok) {
    console.log(`  ${tag}: ❌ ${res.code} — ${res.error}`);
    return;
  }
  const rows = res.rows || [];
  if (!rows.length) {
    console.log(`  ${tag}: 0 条（ok，真的没有匹配）`);
    return;
  }
  const top = rows.slice(0, 3).map((r) => `${r.id}/${r.score.toFixed(3)}/${r.level}`);
  console.log(`  ${tag}: ${rows.length} 条 → ${top.join('  ')}`);
}

const env = await createAppEnv({ endpoint: ENDPOINT, key: KEY });
console.log(`SDK: ${env.sdkCached ? '本地缓存' : '刚下载'} · ${env.sdkFile}`);
console.log(`endpoint: ${env.LF.config.endpoint}`);

console.log('\n[一] 正常查询（走 SDK rpc）');
let okCount = 0;
for (const q of QUERIES) {
  const res = await env.LF.api.searchItems(q, 5);
  show(JSON.stringify(q), res);
  if (res.ok) okCount += 1;
}

console.log('\n[二] 返回列必须只有公开字段');
const one = await env.LF.api.searchItems('耳机', 1);
if (one.ok && one.rows.length) {
  const keys = Object.keys(one.rows[0]).sort();
  const priv = ['detail', 'location', 'ai_desc', 'ai_tags'].filter((k) => k in one.rows[0]);
  console.log(`  列: ${keys.join(', ')}`);
  console.log(`  私有列: ${priv.length ? '❌ ' + priv.join(',') : '无 ✅'}`);
} else {
  console.log('  ❌ 拿不到样例行，无法检查列');
}

console.log('\n[三] 密钥错误时必须「明确失败」而不是「0 条」');
const bad = await createAppEnv({ endpoint: ENDPOINT, key: 'wbpk_invalid_key_for_probe' });
const badRes = await bad.LF.api.searchItems('耳机', 5);
console.log(`  ok=${badRes.ok} code=${badRes.code || '—'}`);
console.log(`  ${badRes.ok ? '❌ 竟然成功了' : '✅ 明确报错，不会假装没有匹配'}`);

process.exit(okCount === QUERIES.length ? 0 : 1);
