/**
 * tests/lib/sandbox.mjs —— 在 Node 里跑浏览器脚本的最小沙箱
 *
 * 用途：assets/api.js、assets/textsearch.js 都是「挂在 window.LF 上的 IIFE」，
 * 直接 import 跑不了。这里用 node:vm 造一个够用的上下文（localStorage / document
 * 桩 + 假的 WorkBuddyCloud），把真实文件原样跑进去 —— 测的是**线上那份代码**，
 * 不是测试里另写一遍的实现。
 *
 * 两个注意点：
 *   1) 对象跨 realm：vm 里造出来的数组/对象原型与本进程不同，assert.deepStrictEqual
 *      会因为原型不同而失败。统一用 `toHost()` 过一遍 JSON 再断言。
 *   2) api.js 在加载期就会访问 localStorage（清旧缓存），所以桩必须在 run 之前就位。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..', '..');

/** 内存版 localStorage（含 removeItem，api.js 会清旧 key） */
export function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _dump: () => Object.fromEntries(map)
  };
}

/**
 * @param {object} [opts]
 * @param {object} [opts.WorkBuddyCloud]  假的 SDK 全局对象
 * @param {object} [opts.config]          覆盖 LF.config 的字段
 * @param {object} [opts.document]        覆盖 document 桩的字段
 * @param {object} [opts.storage]         localStorage 桩（默认空）
 * @param {string} [opts.search]          location.search，用于开关判定
 */
export function createSandbox(opts = {}) {
  const sandbox = {
    console,
    localStorage: opts.storage || makeStorage(),
    document: makeDocument(opts.document || {}),
    location: { search: opts.search || '', hash: '', pathname: '/' },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    LF: {
      config: Object.assign({
        endpoint: 'https://test.invalid',
        publishableKey: 'wbpk_test',
        table: 'lost_items',
        messageTable: 'item_messages',
        categories: [],
        colorTones: [],
        agent: {}
      }, opts.config || {})
    },
    WorkBuddyCloud: opts.WorkBuddyCloud
  };
  vm.createContext(sandbox);
  sandbox.window = sandbox;      // api.js 用 window.WorkBuddyCloud / window.LF
  sandbox.globalThis = sandbox;
  return sandbox;
}

/** 把仓库里的浏览器脚本跑进沙箱 */
export function loadScript(relPath, sandbox) {
  const abs = path.join(ROOT, relPath);
  vm.runInContext(fs.readFileSync(abs, 'utf8'), sandbox, { filename: abs });
  return sandbox.LF;
}

/** 跨 realm 复制一份普通数据，便于 deepStrictEqual */
export function toHost(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/**
 * 极简 document 桩：只实现被测代码真正用到的方法。
 * 记录 innerHTML / textContent / className，供断言读取。
 */
export function makeDocument(extra = {}) {
  const nodes = new Map();
  function node(id) {
    if (nodes.has(id)) return nodes.get(id);
    const el = {
      id,
      innerHTML: '',
      textContent: '',
      className: '',
      value: '',
      hidden: true,
      disabled: false,
      style: {},
      dataset: {},
      children: [],
      classList: {
        _set: new Set(),
        add(...c) { c.forEach((x) => this._set.add(x)); },
        remove(...c) { c.forEach((x) => this._set.delete(x)); },
        contains(c) { return this._set.has(c); }
      },
      addEventListener() {},
      removeEventListener() {},
      appendChild(c) { this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      setAttribute(k, v) { this[k] = v; },
      getAttribute(k) { return this[k]; }
    };
    nodes.set(id, el);
    return el;
  }
  const doc = {
    _nodes: nodes,
    getElementById: (id) => node(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => node('__created_' + Math.random())
  };
  return Object.assign(doc, extra);
}
