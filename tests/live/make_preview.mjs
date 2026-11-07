/**
 * tests/live/make_preview.mjs —— 生成「连测试库」的浏览器预览（不碰生产）
 *
 * 为什么需要它：真联调脚本证明的是「Node + SDK + api.js」这条链路，
 * 但页面还有一层（DOM、开关、渲染、广场卡片）。要在浏览器里点，就得有一个
 * 指向**测试应用**的页面副本 —— 直接改仓库里的 assets/config.js 会把生产地址
 * 换成测试地址，那是绝对不能发生的事。
 *
 * 做法：仓库里的 index.html + assets/ 原样复制到输出目录，**只改副本**的
 * config.js（endpoint / publishableKey 换成 .env.test 里的值），并追加一个
 * 仅供预览的 `?broken=1` 故障注入（把密钥改成错的，用来演示「请求失败」）。
 *
 * 三重护栏，任何一条不满足就拒绝生成：
 *   1. .env.test 必须存在，且 endpoint 不能包含生产域名；
 *   2. 生成后全目录扫描，出现生产域名、生产密钥就直接删掉产物并报错；
 *   3. 打印/写入 `preview-manifest.json`，记录这次预览连的是哪个 applicationId。
 *
 * 用法：
 *   node tests/live/make_preview.mjs [--out <dir>]
 *   默认输出到 <repo>/.preview-test（已 gitignore）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const PROD_HOST = 'lost-found-75068.app.workbuddy.host';
const PROD_KEY_PREFIX = 'wbpk_lmzAUiNMSssVs6mpvimKsP';

function readEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function die(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
let outDir = path.join(ROOT, '.preview-test');
const iOut = args.indexOf('--out');
if (iOut >= 0 && args[iOut + 1]) outDir = path.resolve(args[iOut + 1]);

const envFile = path.join(ROOT, '.env.test');
if (!fs.existsSync(envFile)) {
  die('缺少 .env.test（WB_TEST_ENDPOINT / WB_TEST_KEY）—— 没有测试应用就不生成预览，绝不回落到生产配置。');
}
const env = readEnvFile(envFile);
const endpoint = (env.WB_TEST_ENDPOINT || '').replace(/\/+$/, '');
const key = env.WB_TEST_KEY || '';

if (!endpoint || !key) die('.env.test 里缺少 WB_TEST_ENDPOINT 或 WB_TEST_KEY');
if (endpoint.includes(PROD_HOST)) die(`.env.test 的 endpoint 指向生产域名（${PROD_HOST}），拒绝生成预览。`);
if (key.startsWith(PROD_KEY_PREFIX)) die('.env.test 用的是生产密钥，拒绝生成预览。');
if (!/^https?:\/\//.test(endpoint)) die(`endpoint 不像一个地址：${endpoint}`);

/* ---------- 1. 复制 index.html + assets ---------- */
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(outDir, 'index.html'));
fs.cpSync(path.join(ROOT, 'assets'), path.join(outDir, 'assets'), { recursive: true });

/* ---------- 2. 只改副本的 config.js ---------- */
const cfgFile = path.join(outDir, 'assets/config.js');
let cfg = fs.readFileSync(cfgFile, 'utf8');
const before = cfg;
cfg = cfg
  .replace(/endpoint:\s*'[^']*'/, `endpoint: '${endpoint}'`)
  .replace(/publishableKey:\s*'[^']*'/, `publishableKey: '${key}'`);
if (cfg === before) die('config.js 里没找到 endpoint / publishableKey，预览没改成测试库，停止。');
if (cfg.includes(PROD_HOST) || cfg.includes(PROD_KEY_PREFIX)) die('config.js 替换后仍含生产配置，停止。');

// 故障注入：只改这份副本，仓库里的代码没有这个开关
cfg += `

/* ------------------------------------------------------------------
 * 仅预览副本：?broken=1 把密钥换成无效值，用来演示「请求失败」长什么样。
 * 这一段不会出现在仓库的 assets/config.js 里（由 tests/live/make_preview.mjs 追加）。
 * ------------------------------------------------------------------ */
if (typeof location !== 'undefined' && /(?:\\?|&)broken=1(?:&|$)/.test(location.search)) {
  LF.config.publishableKey = 'wbpk_preview_invalid_key_for_failure_demo';
}
`;
fs.writeFileSync(cfgFile, cfg);

/* ---------- 3. 产物自检：不许留生产痕迹 ---------- */
const offenders = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (!/\.(js|html|css|json)$/.test(name)) continue;
    const text = fs.readFileSync(p, 'utf8');
    if (text.includes(PROD_HOST) || text.includes(PROD_KEY_PREFIX)) offenders.push(path.relative(outDir, p));
  }
})(outDir);

if (offenders.length) {
  fs.rmSync(outDir, { recursive: true, force: true });
  die(`产物里仍出现生产配置：${offenders.join(', ')}（已删除产物）`);
}

const manifest = {
  generatedAt: new Date().toISOString(),
  applicationId: env.WB_TEST_APP_ID || '(未写)',
  endpoint,
  outDir,
  urls: {
    'switch-off': '/',
    'switch-on': '/?textsearch=1',
    'request-failure': '/?textsearch=1&broken=1'
  },
  note: '预览副本只连测试应用；生产域名与生产密钥已全目录扫描，均不存在。'
};
fs.writeFileSync(path.join(outDir, 'preview-manifest.json'), JSON.stringify(manifest, null, 2));

console.log('✅ 预览已生成（连测试库，不是生产）');
console.log(`   目录：${outDir}`);
console.log(`   应用：${manifest.applicationId}`);
console.log(`   地址：${endpoint}`);
console.log('   页面： /  |  /?textsearch=1  |  /?textsearch=1&broken=1');
console.log('   自检： 全目录无生产域名、无生产密钥');
