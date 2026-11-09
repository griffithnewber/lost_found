/**
 * tests/live/probe_sync.mjs —— 只读诊断：广场首屏到底能不能拉到云端
 *
 * 跑的是真实链路（CDN 上的 WorkBuddyCloud SDK + assets/config.js + assets/api.js），
 * 和浏览器打开 index.html 时执行的代码一致，不手搓 fetch。只读，不写入。
 *
 * 两个场景：
 *   ① SDK 正常 → 期望 lastSync.via = 'sdk'
 *   ② SDK 被拦（把 window.WorkBuddyCloud 置空，模拟 jsdelivr 拿不到）
 *      → 期望 lastSync.via = 'rest'，条数一样
 *
 * 用法：node tests/live/probe_sync.mjs
 */
import { createAppEnv } from './sdk_harness.mjs';

const endpoint = 'https://lost-found-56662.app.workbuddy.host';
const key = 'wbpk_7WvCzu8yW3N6uppqR8xFUp_LqOna90BvIXCH5ET2FwqGrOebsmhNbAY';

async function run(label, mutate) {
  const env = await createAppEnv({ endpoint, key });
  if (mutate) mutate(env.sandbox);
  const t0 = Date.now();
  const list = await env.LF.api.listItems();
  console.log(`${label}：${list.length} 条 / ${Date.now() - t0}ms / via=${env.LF.api.lastSync.via}`);
  if (env.LF.api.lastSync.sdk) console.log(`   SDK 失败原因：${env.LF.api.lastSync.sdk}`);
  return { list, via: env.LF.api.lastSync.via, sync: env.LF.api.lastSync };
}

const a = await run('① SDK 正常', null);
const b = await run('② SDK 被拦', (sb) => { sb.WorkBuddyCloud = undefined; });

const bad = [];
if (!a.list.length || a.via !== 'sdk') bad.push('① 应该走 SDK 且非空');
if (!b.list.length || b.via !== 'rest') bad.push('② 应该落到直连 REST 且非空');

if (bad.length) {
  console.log('\n❌ ' + bad.join('；'));
  process.exit(1);
}
console.log('\n✅ 两条通道都能出数据，数据条数一致：' + (a.list.length === b.list.length));
