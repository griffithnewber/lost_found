/**
 * tests/live/sdk_harness.mjs —— 在 Node 里跑**网页真正用的那套代码**
 *
 * 为什么不用 curl 直接打 REST：
 *   那样只能证明「网关通」，证明不了「网页调得通」。真实链路是
 *       index.html → WorkBuddyCloud.createWorkBuddyCloud(config) → database.rpc(...)
 *   中间还有 SDK 自己拼 URL / 带鉴权头 / 解包错误对象这一层。
 *   所以这里把 CDN 上那份 SDK 原样下载下来，连同 assets/config.js、assets/api.js
 *   一起丢进 node:vm 的沙箱里跑 —— 测的是线上那份 JS，不是测试里另写一遍。
 *
 * 缓存：SDK 首次下载后存到 tests/live/.cache/（已 gitignore），后续离线可用。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..', '..');
const CACHE_DIR = path.join(HERE, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'workbuddy-cloud-sdk.global.js');
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';

/** 取 SDK 源码（优先本地缓存） */
export async function loadSdkSource({ refresh = false } = {}) {
  if (!refresh && fs.existsSync(CACHE_FILE)) {
    return { source: fs.readFileSync(CACHE_FILE, 'utf8'), cached: true, file: CACHE_FILE };
  }

  let source = null;
  let via = 'fetch';
  try {
    const res = await fetch(SDK_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    source = await res.text();
  } catch (e) {
    // 有些网络里 Node 的 fetch 连不上 jsdelivr（curl 却能），退一步用 curl 抓同一份产物。
    // 抓的是同一个 URL、同一个文件，不改变「跑的是 CDN 上那份 SDK」这件事。
    via = 'curl';
    try {
      source = execFileSync('curl', ['-sSL', '--max-time', '40', SDK_URL], {
        encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
      });
    } catch (e2) {
      throw new Error(
        `下载 SDK 失败（fetch: ${e.message}；curl: ${e2.message}）。\n` +
        `可手动下载后放到 ${CACHE_FILE}，或用 --refresh-sdk 重试。`
      );
    }
  }
  if (!source || source.length < 1000) throw new Error(`SDK 内容异常（${source ? source.length : 0} 字节）`);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, source);
  return { source, cached: false, via, file: CACHE_FILE };
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    key: () => null,
    get length() { return map.size; }
  };
}

/** 网页里 SDK 会碰到的 DOM，最小桩 */
function makeDocument() {
  const el = () => ({
    textContent: '', className: '', innerHTML: '', value: '', hidden: true,
    style: {}, classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, appendChild() {}, removeChild() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; }
  });
  return {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: el,
    addEventListener() {},
    body: { appendChild() {}, removeChild() {} }
  };
}

/**
 * 建一个「像浏览器」的沙箱，并把 config.js + api.js 跑进去。
 * @param {{endpoint:string, key:string, search?:string, timeoutMs?:number}} opts
 */
export async function createAppEnv({ endpoint, key, search = '' }) {
  const { source, cached, file } = await loadSdkSource();

  const sandbox = {
    console,
    fetch,
    Headers,
    Request,
    Response,
    AbortController,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    document: makeDocument(),
    navigator: { userAgent: 'node-lf-smoke/1.0', language: 'zh-CN' },
    location: {
      href: endpoint.replace(/\/$/, '') + '/',
      origin: endpoint.replace(/\/$/, ''),
      protocol: 'https:',
      search,
      hash: '',
      pathname: '/'
    }
  };
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  vm.runInContext(source, sandbox, { filename: 'workbuddy-cloud-sdk.global.js' });
  if (!sandbox.WorkBuddyCloud || typeof sandbox.WorkBuddyCloud.createWorkBuddyCloud !== 'function') {
    throw new Error('SDK 加载后没有暴露 WorkBuddyCloud.createWorkBuddyCloud');
  }

  const runFile = (rel) => {
    const abs = path.join(ROOT, rel);
    vm.runInContext(fs.readFileSync(abs, 'utf8'), sandbox, { filename: abs });
  };

  // 真实前端配置，再按测试环境覆盖 endpoint / key：
  // 这样既跑了同一份 config.js 的形状，又保证不会打到生产。
  runFile(path.join('assets', 'config.js'));
  sandbox.LF.config.endpoint = endpoint.replace(/\/$/, '');
  sandbox.LF.config.publishableKey = key;
  runFile(path.join('assets', 'api.js'));

  return {
    sandbox,
    LF: sandbox.LF,
    sdk: sandbox.WorkBuddyCloud,
    sdkCached: cached,
    sdkFile: file
  };
}
