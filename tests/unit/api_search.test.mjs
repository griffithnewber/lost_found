/**
 * tests/unit/api_search.test.mjs
 *
 * 被测对象：assets/api.js 的 LF.api.searchItems()（真实文件，跑在 vm 沙箱里）
 *
 * 这一组用例只盯一件事：**失败不许伪装成「没有匹配」**。
 *   - rpc 返回体缺 data / data 不是数组 → ok:false + code
 *   - 客户端初始化抛错 → ok:false + client_init_failed
 *   - SDK 没有 rpc → ok:false + rpc_unsupported
 *   - 函数不存在（PGRST202） → ok:false + rpc_missing
 *   - 只有「成功且真的 0 行」才是 ok:true + rows:[]
 * 顺带锁住映射：顺序、score / rank / level / label 原样带出，私有字段不外泄。
 *
 * 跑法：cd tests && node --test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, loadScript, toHost } from '../lib/sandbox.mjs';

/** 造一个只有 database.rpc 的假云客户端 */
function makeApi({ rpc, database, createThrows } = {}) {
  const sandbox = createSandbox({
    WorkBuddyCloud: {
      createWorkBuddyCloud() {
        if (createThrows) throw createThrows;
        if (database !== undefined) return { database };
        return { database: { rpc } };
      }
    }
  });
  loadScript('assets/api.js', sandbox);
  return sandbox.LF.api;
}

const ROW = {
  id: 102,
  title: '黑色·耳机',
  category: 'headphones',
  color_tone: 'black',
  notice: '操场东侧看台捡到一副黑色无线耳机',
  status: 'open',
  post_type: 'found',
  pub_time: '2026/11/6 15:30:00',
  pickup_location: '体育馆器材室',
  score: 0.9518,
  level: 'high',
  label: '很可能就是它 · 95%',
  rank: 1,
  algorithm_version: 'lf-text-v1@cc9e40d',
  // 万一服务端多给了私有列，也不能进 item
  detail: '右耳柄外侧有一道浅划痕',
  ai_desc: '黑色入耳式耳机',
  location: '看台第三排'
};

describe('LF.api.searchItems · 成功路径', () => {
  it('顺序 / score / rank / level / label 原样带出，私有字段不外泄', async () => {
    const rows = [
      Object.assign({}, ROW, { id: 5, score: 0.7, rank: 1, level: 'high', label: '很可能就是它 · 70%' }),
      Object.assign({}, ROW, { id: 9, score: 0.4, rank: 2, level: 'mid', label: '有点接近 · 40%' }),
      Object.assign({}, ROW, { id: 7, score: 0.2, rank: 3, level: 'low', label: '参考项 · 20%' })
    ];
    const api = makeApi({ rpc: async () => ({ data: rows, error: null }) });
    const res = await api.searchItems('黑色耳机', 3);

    assert.equal(res.ok, true);
    const out = toHost(res.rows);
    assert.deepEqual(out.map((r) => r.item.id), [5, 9, 7], '必须保持函数返回的顺序');
    assert.deepEqual(out.map((r) => r.rank), [1, 2, 3]);
    assert.deepEqual(out.map((r) => r.level), ['high', 'mid', 'low']);
    assert.deepEqual(out.map((r) => r.label), ['很可能就是它 · 70%', '有点接近 · 40%', '参考项 · 20%']);
    assert.deepEqual(out.map((r) => r.score), [0.7, 0.4, 0.2]);
    assert.equal(out[0].algorithmVersion, 'lf-text-v1@cc9e40d');

    for (const r of out) {
      for (const k of ['detail', 'location', 'aiDesc', 'aiTags', 'ai_desc', 'ai_tags']) {
        assert.equal(Object.prototype.hasOwnProperty.call(r.item, k), false, `item 不该带 ${k}`);
      }
    }
  });

  it('成功但 0 行 → ok:true + 空数组（这才是「没有匹配」）', async () => {
    const api = makeApi({ rpc: async () => ({ data: [], error: null }) });
    const res = await api.searchItems('不存在的东西');
    assert.equal(res.ok, true);
    assert.deepEqual(toHost(res.rows), []);
  });

  it('入参规整：query=null → ""；limit=0 → 20', async () => {
    let seen = null;
    const api = makeApi({
      rpc: async (name, params) => { seen = { name, params }; return { data: [] }; }
    });
    await api.searchItems(null, 0);
    assert.equal(seen.name, 'lf_search_text_v1');
    assert.equal(seen.params.p_query, '');
    assert.deepEqual(toHost(seen.params.p_keywords), []);
    assert.equal(seen.params.p_limit, 20, 'limit=0 会让函数返回 0 行，必须兜底成 20');

    await api.searchItems('耳机', 999);
    assert.equal(seen.params.p_limit, 200, 'limit 上限夹到 200');
  });

  /* 两端一致的前提：网页对原话只 trim，不做任何改写，也绝不自己扩同义词。
     这三条断言就是那个「前提」的可执行版本。 */
  it('输入契约：只 trim，保留大小写与标点，不改写原话', async () => {
    let seen = null;
    const api = makeApi({
      rpc: async (name, params) => { seen = params; return { data: [] }; }
    });
    await api.searchItems('  iPhone 15（白色） pro  ');
    assert.equal(seen.p_query, 'iPhone 15（白色） pro',
      '只去掉首尾空白：大小写、全角括号、词序都必须原样');
  });

  it('输入契约：p_keywords 恒为 []，调用方塞不进来', async () => {
    let seen = null;
    const api = makeApi({
      rpc: async (name, params) => { seen = params; return { data: [] }; }
    });
    // 就算老代码还按 (query, keywords, limit) 调：第二个参数会被当成 limit（非数字 → 兜底 20），
    // 第三个参数被忽略。关键在于 p_keywords 永远是空数组 —— 同义词只能由 SQL 字典决定。
    await api.searchItems('雨伞', ['遮阳伞', 'umbrella'], 5);
    assert.deepEqual(toHost(seen.p_keywords), [], '网页不得自行扩同义词');
    assert.equal(seen.p_limit, 20, '非数字 limit 兜底成 20，旧的三参数写法塞不进关键词');
  });
});

describe('LF.api.searchItems · 失败路径（都不能变成「没有匹配」）', () => {
  const cases = [
    { name: 'rpc 返回 undefined', rpc: async () => undefined, code: 'rpc_bad_response' },
    { name: 'rpc 返回 null', rpc: async () => null, code: 'rpc_bad_response' },
    { name: '返回体缺 data', rpc: async () => ({ error: null }), code: 'rpc_bad_response' },
    { name: 'data 为 null', rpc: async () => ({ data: null }), code: 'rpc_bad_response' },
    { name: 'data 是对象', rpc: async () => ({ data: { id: 1 } }), code: 'rpc_bad_response' },
    { name: 'data 是字符串', rpc: async () => ({ data: 'oops' }), code: 'rpc_bad_response' }
  ];

  for (const c of cases) {
    it(`${c.name} → ok:false / ${c.code}`, async () => {
      const api = makeApi({ rpc: c.rpc });
      const res = await api.searchItems('耳机');
      assert.equal(res.ok, false, `${c.name} 不能判成功`);
      assert.equal(res.code, c.code);
      assert.equal(res.rows, undefined, '失败时不许给 rows（否则调用方会当成空结果）');
      assert.ok(res.error && res.error.length > 0, '失败必须带可读错误');
      assert.match(res.error, /不代表|不是|异常|失败/, '错误文案要明确区分「失败」与「没有匹配」');
    });
  }

  it('rpc 返回 error（PGRST202 函数不存在）→ rpc_missing', async () => {
    const api = makeApi({
      rpc: async () => ({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function public.lf_search_text_v1(p_query)' }
      })
    });
    const res = await api.searchItems('耳机');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'rpc_missing');
    assert.match(res.error, /Could not find the function/);
  });

  it('rpc 抛其他错误 → rpc_failed', async () => {
    const api = makeApi({ rpc: async () => { throw { code: 'PGRST301', message: 'JWT expired' }; } });
    const res = await api.searchItems('耳机');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'rpc_failed');
    assert.match(res.error, /JWT expired/);
  });

  it('网络层直接 reject（TypeError: fetch failed）→ rpc_failed', async () => {
    const api = makeApi({ rpc: async () => { throw new TypeError('fetch failed'); } });
    const res = await api.searchItems('耳机');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'rpc_failed');
    assert.match(res.error, /fetch failed/);
  });

  it('云客户端初始化抛错 → client_init_failed', async () => {
    const api = makeApi({ createThrows: new Error('publishableKey missing') });
    const res = await api.searchItems('耳机');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'client_init_failed');
    assert.match(res.error, /publishableKey missing/);
  });

  it('SDK 没有 rpc 能力 → rpc_unsupported', async () => {
    const api = makeApi({ database: { from() {} } });
    const res = await api.searchItems('耳机');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'rpc_unsupported');
  });

  it('SDK 全局对象缺失（脚本没加载）→ client_init_failed', async () => {
    const sandbox = createSandbox({ WorkBuddyCloud: undefined });
    loadScript('assets/api.js', sandbox);
    const res = await sandbox.LF.api.searchItems('耳机');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'client_init_failed');
  });
});
