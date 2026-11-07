/**
 * tests/lib/legacy.mjs —— 把 cc9e40d 的历史前端实现装进 Node vm
 *
 * 加载顺序刻意与历史 index.html 一致：config → (api 占位) → ui → search → match。
 * ui.js 顶部有一行 LF.api.setStatus = LF.ui.setStatus，所以必须先给 LF.api 一个空壳。
 * 这里不做任何"改写/精简"，改了就失去对照基准的意义。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_DIR = path.join(HERE, '..', 'fixtures', 'legacy-cc9e40d');

export function loadLegacyJs() {
  const sandbox = { console };
  sandbox.window = sandbox;      // config.js 用 window.LF
  sandbox.LF = {};
  vm.createContext(sandbox);

  const run = (file) => vm.runInContext(
    fs.readFileSync(path.join(LEGACY_DIR, file), 'utf8'),
    sandbox,
    { filename: file }
  );

  run('config.js');
  sandbox.LF.api = {};           // ui.js 顶部的依赖
  run('ui.js');
  run('search.js');
  run('match.js');

  const LF = sandbox.LF;
  if (!LF || !LF.search || !LF.match) throw new Error('历史 JS 加载失败');

  return {
    config: LF.config,
    searchText: LF.search.text,
    annotate: LF.match.annotate,
    topN: LF.match.topN,
    version: 'cc9e40d'
  };
}

/** 历史实现里 LF.match 的阈值，写死成常量供断言用 */
export const LEGACY_THRESHOLDS = { HIGH: 0.5, MID: 0.25, FILTER: 0.08 };
