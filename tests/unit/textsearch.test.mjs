/**
 * tests/unit/textsearch.test.mjs
 *
 * 被测对象：assets/textsearch.js（真实文件，跑在 vm 沙箱里）+ assets/api.js + assets/ui.js
 *
 * 要锁住的四件事：
 *   1. 开关关着时卡片保持隐藏、不挂载（页面表现与只读看板一致）；
 *   2. 结果只来自 LF.api.searchItems()，HTML 里的顺序与 label/score/rank 照抄返回值；
 *   3. 检索失败 → 显示「检索失败：…（这是失败，不是没有匹配）」，列表为空；
 *   4. 只有「成功且 0 条」才说「没有匹配」。
 *
 * 跑法：cd tests && node --test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSandbox, loadScript, ROOT, toHost } from '../lib/sandbox.mjs';

function boot({ search = '', config = {}, searchItems } = {}) {
  const sandbox = createSandbox({ search, config });
  sandbox.WorkBuddyCloud = undefined;      // 这些用例不打网络，只用桩
  loadScript('assets/api.js', sandbox);
  loadScript('assets/ui.js', sandbox);
  loadScript('assets/textsearch.js', sandbox);
  if (searchItems !== undefined) {
    sandbox.LF.api = Object.assign({}, sandbox.LF.api, { searchItems });
  }
  return sandbox;
}

const HIT = (id, rank, score, level, label) => ({
  item: {
    id, title: '黑色·耳机', category: 'headphones', colorTone: 'black',
    notice: '操场东侧看台捡到一副黑色无线耳机', status: 'open', postType: 'found',
    pickupLocation: '体育馆器材室', time: '2026/11/6 15:30:00'
  },
  score, level, label, rank, algorithmVersion: 'lf-text-v1@cc9e40d'
});

describe('文字检索入口 · 开关', () => {
  it('默认关闭', () => {
    const sb = boot();
    assert.equal(sb.LF.textSearch.enabled(), false);
  });

  it('config.features.textSearch = true 时开启', () => {
    const sb = boot({ config: { features: { textSearch: true } } });
    assert.equal(sb.LF.textSearch.enabled(), true);
  });

  it('?textsearch=1 临时开启；?textsearch=0 优先于 config', () => {
    assert.equal(boot({ search: '?textsearch=1' }).LF.textSearch.enabled(), true);
    assert.equal(boot({ search: '?foo=1&textsearch=1' }).LF.textSearch.enabled(), true);
    assert.equal(boot({ search: '?textsearch=0', config: { features: { textSearch: true } } })
      .LF.textSearch.enabled(), false);
  });

  it('关闭时卡片保持隐藏且不挂载', () => {
    const sb = boot();
    const card = sb.document.getElementById('text-search-card');
    card.hidden = false;                       // 故意先掀开，验证 mount 会重新盖上
    assert.equal(sb.LF.textSearch.mount(), false);
    assert.equal(card.hidden, true);
    assert.equal(sb.LF.textSearch.mounted, false);
  });

  it('开启时卡片显示', () => {
    const sb = boot({ search: '?textsearch=1' });
    const card = sb.document.getElementById('text-search-card');
    assert.equal(sb.LF.textSearch.mount(), true);
    assert.equal(card.hidden, false);
    assert.equal(sb.LF.textSearch.mounted, true);
  });
});

describe('文字检索入口 · describe（纯状态机）', () => {
  it('有结果：state=ok，rows 原样保留', () => {
    const sb = boot();
    const rows = [HIT(5, 1, 0.8457, 'high', '很可能就是它 · 85%'), HIT(9, 2, 0.4, 'mid', '有点接近 · 40%')];
    const d = sb.LF.textSearch.describe({ ok: true, rows });
    assert.equal(d.state, 'ok');
    assert.equal(toHost(d.rows).length, 2);
    assert.match(d.message, /共 2 条/);
  });

  it('成功且 0 条 → state=empty（这才是「没有匹配」）', () => {
    const sb = boot();
    const d = sb.LF.textSearch.describe({ ok: true, rows: [] });
    assert.equal(d.state, 'empty');
    assert.match(d.message, /没有匹配/);
  });

  it('失败一律 state=error，且文案里带「不是没有匹配」', () => {
    const sb = boot();
    for (const res of [
      undefined,
      null,
      { ok: false, code: 'rpc_missing', error: 'Could not find the function' },
      { ok: false, code: 'rpc_bad_response' },
      { ok: true, rows: null },                       // 成功了但 rows 不是数组，也算失败
      { ok: true, rows: { 0: HIT(1, 1, 0.5, 'high', 'x') } }
    ]) {
      const d = sb.LF.textSearch.describe(res);
      assert.equal(d.state, 'error', `应判失败：${JSON.stringify(res)}`);
      assert.match(d.message, /^检索失败：/, `文案必须以「检索失败」开头：${d.message}`);
      assert.match(d.message, /不是没有匹配/, '必须明确区分「失败」与「没有匹配」');
      assert.deepEqual(toHost(d.rows), []);
    }
  });
});

describe('文字检索入口 · 渲染与执行', () => {
  it('成功结果按函数顺序渲染，label / rank / 分数原样展示', async () => {
    const rows = [
      HIT(113, 1, 0.8457, 'high', '很可能就是它 · 85%'),
      HIT(105, 2, 0.7775, 'high', '很可能就是它 · 78%'),
      HIT(102, 3, 0.7382, 'high', '很可能就是它 · 74%')
    ];
    const sb = boot({ searchItems: async () => ({ ok: true, rows }) });
    const res = await sb.LF.textSearch.run('黑色耳机');

    assert.equal(res.ok, true);
    const list = sb.document.getElementById('text-search-list');
    const html = list.innerHTML;

    assert.match(html, /LF-113/, '必须用编号展示');
    assert.match(html, /很可能就是它 · 85%/);
    assert.match(html, /rank 1 · 相关度 0.8457 · high · lf-text-v1@cc9e40d/);
    // 顺序：113 在前，102 在后
    assert.ok(html.indexOf('LF-113') < html.indexOf('LF-105'), '顺序不能被打乱');
    assert.ok(html.indexOf('LF-105') < html.indexOf('LF-102'), '顺序不能被打乱');

    const hint = sb.document.getElementById('text-search-hint');
    assert.match(hint.textContent, /共 3 条/);
    assert.equal(hint.className.includes('ts-error'), false);
  });

  it('调用契约：只把 trim 后的原话 + limit 交给 searchItems，不传关键词', async () => {
    let got = null;
    const sb = boot({ searchItems: async function () { got = Array.prototype.slice.call(arguments); return { ok: true, rows: [] }; } });
    await sb.LF.textSearch.run('  iPhone 15（白色）  ');

    assert.deepEqual(toHost(got[0]), 'iPhone 15（白色）', '只 trim，不转小写、不改写');
    assert.equal(got[1], 10, '第二个参数是 limit');
    assert.equal(got.length, 2, '不得再传第三个参数（关键词数组）——同义词只能由 SQL 字典决定');
  });

  it('空关键词：提示输入，不发请求', async () => {
    let called = 0;
    const sb = boot({ searchItems: async () => { called++; return { ok: true, rows: [] }; } });
    const res = await sb.LF.textSearch.run('   ');
    assert.equal(called, 0, '空输入不该打函数');
    assert.equal(res.code, 'empty_query');
    const hint = sb.document.getElementById('text-search-hint');
    assert.match(hint.textContent, /请先输入关键词/);
    assert.doesNotMatch(hint.textContent, /没有匹配的记录/);
  });

  it('检索失败：显示原因、列表清空，绝不说「没有匹配」', async () => {
    const sb = boot({
      searchItems: async () => ({ ok: false, code: 'rpc_missing', error: '共享检索函数返回错误：Could not find the function' })
    });
    const res = await sb.LF.textSearch.run('耳机');
    assert.equal(res.ok, false);

    const hint = sb.document.getElementById('text-search-hint');
    assert.match(hint.textContent, /检索失败/);
    assert.match(hint.textContent, /Could not find the function/);
    assert.match(hint.textContent, /不是没有匹配/);
    assert.equal(hint.className.includes('ts-error'), true);
    assert.equal(sb.document.getElementById('text-search-list').innerHTML, '');
  });

  it('searchItems 抛异常也不能当成「没有匹配」', async () => {
    const sb = boot({ searchItems: async () => { throw new Error('boom'); } });
    const res = await sb.LF.textSearch.run('耳机');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'unexpected');
    const hint = sb.document.getElementById('text-search-hint');
    assert.match(hint.textContent, /检索失败：boom/);
    assert.match(hint.textContent, /不是没有匹配/);
  });

  it('数据层没有 searchItems 时明确报错（api_missing）', async () => {
    const sb = boot();
    sb.LF.api = {};                       // 模拟 api.js 没加载
    const res = await sb.LF.textSearch.run('耳机');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'api_missing');
    assert.match(sb.document.getElementById('text-search-hint').textContent, /检索失败/);
  });

  it('成功但 0 条：才允许显示「没有匹配」', async () => {
    const sb = boot({ searchItems: async () => ({ ok: true, rows: [] }) });
    await sb.LF.textSearch.run('不存在的东西');
    const hint = sb.document.getElementById('text-search-hint');
    assert.match(hint.textContent, /检索成功，没有匹配的记录/);
    assert.equal(hint.className.includes('ts-error'), false);
  });
});

/* ------------------------------------------------------------------
 * 接线检查：页面里真的有这些元素、脚本顺序也对
 * （纯渲染测试覆盖不到「HTML 改了但 JS 还在找旧 id」这类断线）
 * ------------------------------------------------------------------ */
describe('文字检索入口 · 与 index.html 接线', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  it('卡片与输入/按钮/提示/结果区都在页面里', () => {
    for (const id of ['text-search-card', 'text-search-input', 'btn-text-search',
      'text-search-hint', 'text-search-list']) {
      assert.match(html, new RegExp(`id="${id}"`), `index.html 缺 #${id}`);
    }
  });

  it('卡片默认 hidden（开关关着时与只读看板一致）', () => {
    const tag = html.match(/<div class="card" id="text-search-card"[^>]*>/);
    assert.ok(tag, '找不到卡片标签');
    assert.match(tag[0], /\bhidden\b/, '卡片必须默认 hidden');
  });

  it('textsearch.js 在 app.js 之前引入（横幅文案要读开关）', () => {
    const iTs = html.indexOf('assets/textsearch.js');
    const iApp = html.indexOf('assets/app.js');
    assert.ok(iTs > 0, 'index.html 没有引入 textsearch.js');
    assert.ok(iTs < iApp, 'textsearch.js 必须在 app.js 之前');
  });
});
