/**
 * tests/sql/permissions.test.mjs
 *
 * 目的：把「函数权限面」变成可回归的断言，而不是一次性人工检查。
 *
 * 检查项：
 *   1. 只有 lf_search_text_v1 是 SECURITY DEFINER，其余 helper 全是 INVOKER；
 *   2. 所有 lf_* 函数的 search_path 都被钉死为 pg_catalog（不留 public / pg_temp）；
 *   3. EXECUTE：anon / authenticated 只对主函数有权限，对 helper 一律没有；
 *      PUBLIC 不再持有任何 EXECUTE（proacl 里不应出现 grantee=0）；
 *   4. 执行身份是**表 owner**（这里特意把 owner 换成一个普通角色 app_owner，
 *      证明不依赖超级用户也能跑），并且 anon 实调能拿到结果。
 *
 * 跑法：cd tests && node --test
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const MIGRATION = path.join(ROOT, 'db', 'migrations', '2026-11-07_lf_search_text_v1.sql');
const SCHEMA = path.join(ROOT, 'tests', 'fixtures', 'schema_lost_items.sql');

const FN_SIGS = [
  'lf_search_text_v1(text,text[],integer)',
  'lf_expand_v1(text)',
  'lf_u16_units_v1(text)',
  'lf_bigrams_v1(text)',
  'lf_dice_v1(text,text)',
  'lf_haystack_v1(text,text,text,text,jsonb)',
  'lf_ai_tags_text_v1(jsonb)',
  'lf_category_label_v1(text)',
  'lf_color_label_v1(text)'
];

describe('函数权限面（隔离库，owner 为普通角色）', () => {
  let db;

  before(async () => {
    db = new PGlite();
    // 生产库这三个角色本来就有；迁移里的 GRANT 依赖它们存在
    await db.exec(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN;
      CREATE ROLE app_owner NOLOGIN;      -- 代表 lost_items 的表 owner（非超级用户）
    `);
    await db.exec(fs.readFileSync(SCHEMA, 'utf8'));
    await db.exec(fs.readFileSync(MIGRATION, 'utf8'));

    // 把表与函数改归普通角色，模拟生产「函数 owner = 表 owner」而非 postgres
    await db.exec(`
      ALTER TABLE public.lost_items OWNER TO app_owner;
      GRANT USAGE ON SCHEMA public TO app_owner;
      ALTER FUNCTION public.lf_search_text_v1(text,text[],integer) OWNER TO app_owner;
      ALTER FUNCTION public.lf_expand_v1(text) OWNER TO app_owner;
      ALTER FUNCTION public.lf_u16_units_v1(text) OWNER TO app_owner;
      ALTER FUNCTION public.lf_bigrams_v1(text) OWNER TO app_owner;
      ALTER FUNCTION public.lf_dice_v1(text,text) OWNER TO app_owner;
      ALTER FUNCTION public.lf_haystack_v1(text,text,text,text,jsonb) OWNER TO app_owner;
      ALTER FUNCTION public.lf_ai_tags_text_v1(jsonb) OWNER TO app_owner;
      ALTER FUNCTION public.lf_category_label_v1(text) OWNER TO app_owner;
      ALTER FUNCTION public.lf_color_label_v1(text) OWNER TO app_owner;
    `);

    await db.query(
      `INSERT INTO lost_items (id, title, detail, notice, status, post_type, category, color_tone, created_at)
       OVERRIDING SYSTEM VALUE
       VALUES (1, '黑色·耳机', '右耳柄外侧有一道浅划痕', '操场东侧看台捡到一副黑色无线耳机',
               'open', 'found', 'headphones', 'black', now())`
    );
  });

  after(async () => { await db.close(); });

  it('只有主函数是 SECURITY DEFINER，其余都是 INVOKER', async () => {
    const res = await db.query(
      `SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'lf\\_%' ORDER BY p.proname`
    );
    const byName = Object.fromEntries(res.rows.map((r) => [r.proname, r]));
    assert.equal(byName.lf_search_text_v1.prosecdef, true, '主函数必须 DEFINER 才能读 detail');
    assert.equal(byName.lf_search_text_v1.owner, 'app_owner');
    for (const [name, row] of Object.entries(byName)) {
      if (name === 'lf_search_text_v1') continue;
      assert.equal(row.prosecdef, false, `${name} 不应是 DEFINER`);
      assert.equal(row.owner, 'app_owner');
    }
  });

  it('每个 lf_* 函数的 search_path 都钉死为 pg_catalog', async () => {
    const res = await db.query(
      `SELECT p.proname, coalesce(array_to_string(p.proconfig, ','), '') AS cfg
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'lf\\_%'`
    );
    assert.equal(res.rows.length, 9);
    for (const r of res.rows) {
      assert.match(r.cfg, /search_path=pg_catalog/, `${r.proname} 缺 search_path`);
      assert.doesNotMatch(r.cfg, /public|pg_temp/, `${r.proname} 的 search_path 含 public/pg_temp`);
    }
  });

  it('EXECUTE：客户端角色只有主函数，helper 一律没有', async () => {
    const res = await db.query(
      `SELECT p.oid::regprocedure::text AS sig, p.proname,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_exec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'lf\\_%'`
    );
    for (const r of res.rows) {
      const isMain = r.proname === 'lf_search_text_v1';
      assert.equal(r.anon_exec, isMain, `${r.sig}：anon EXECUTE 应为 ${isMain}`);
      assert.equal(r.auth_exec, isMain, `${r.sig}：authenticated EXECUTE 应为 ${isMain}`);
      assert.equal(r.svc_exec, isMain, `${r.sig}：service_role EXECUTE 应为 ${isMain}`);
    }
  });

  it('PUBLIC 不再持有任何 lf_* 的 EXECUTE（proacl 里没有 grantee=0）', async () => {
    const res = await db.query(
      `SELECT p.proname, coalesce(array_to_string(p.proacl, ' '), '(默认)') AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'lf\\_%'`
    );
    for (const r of res.rows) {
      assert.notEqual(r.acl, '(默认)', `${r.proname} 还留着默认 ACL（= PUBLIC 可执行）`);
      assert.doesNotMatch(r.acl, /(^|[ {,])=/, `${r.proname} 的 ACL 仍含 PUBLIC 授受：${r.acl}`);
    }
  });

  it('anon 实调主函数能拿到结果；调 helper 被拒', async () => {
    await db.exec('SET ROLE anon');
    try {
      const ok = await db.query(
        "SELECT id, title, score FROM public.lf_search_text_v1('黑色耳机', '{}', 3)"
      );
      assert.ok(ok.rows.length > 0, 'anon 应能通过 DEFINER 函数检索');
      assert.ok(Number(ok.rows[0].score) > 0);

      for (const call of [
        "SELECT public.lf_dice_v1('a','a')",
        "SELECT public.lf_bigrams_v1('耳机')",
        "SELECT public.lf_u16_units_v1('耳机')",
        "SELECT public.lf_expand_v1('耳机')",
        "SELECT public.lf_category_label_v1('headphones')",
        "SELECT public.lf_color_label_v1('black')"
      ]) {
        await assert.rejects(() => db.query(call), /permission denied/i, `${call} 应被拒绝`);
      }
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  it('SECURITY DEFINER 没有额外提权面：函数体内不 SET ROLE，也不引用 session_user', async () => {
    const res = await db.query(
      `SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'lf_search_text_v1'`
    );
    const src = res.rows[0].prosrc;
    assert.doesNotMatch(src, /SET\s+ROLE/i);
    assert.doesNotMatch(src, /session_user|current_setting\s*\(\s*'role'/i);
    assert.doesNotMatch(src, /superuser/i);
  });
});

/* =====================================================================
 * 回归：库上配了 ALTER DEFAULT PRIVILEGES 时，helper 是否仍然收得住
 *
 * 背景（这是一条真实的漏权路径，不是假想）：
 *   PostgreSQL 允许
 *       ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon;
 *   配过之后，本迁移 CREATE 出来的每个函数都会自动带一条 **直接授予 anon**
 *   的 ACL 项。旧写法只有 `REVOKE ... FROM PUBLIC`，它只删 grantee=PUBLIC
 *   （oid 0）那一项，碰不到 anon 那条 —— anon 依旧能 rpc 直打 lf_dice_v1。
 *
 * 用例同时验证「重复执行迁移」后的结果（CREATE OR REPLACE 会保留已有 ACL，
 * 但 REVOKE 仍应把任何新出现的授权收掉，不能因为第二遍就放宽）。
 * ===================================================================== */
describe('函数权限面 · ALTER DEFAULT PRIVILEGES 回归', () => {
  const HELPER_SIGS = [
    'lf_expand_v1(text)',
    'lf_u16_units_v1(text)',
    'lf_bigrams_v1(text)',
    'lf_dice_v1(text,text)',
    'lf_haystack_v1(text,text,text,text,jsonb)',
    'lf_ai_tags_text_v1(jsonb)',
    'lf_category_label_v1(text)',
    'lf_color_label_v1(text)'
  ];
  const CLIENTS = ['anon', 'authenticated', 'service_role'];
  let db2;

  before(async () => {
    db2 = new PGlite();
    await db2.exec(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN;
    `);
    // 先给「之后新建的所有函数」预置一条客户端 EXECUTE —— 模拟带默认权限的库
    await db2.exec(`
      ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS
        TO anon, authenticated, service_role;
    `);
    await db2.exec(fs.readFileSync(SCHEMA, 'utf8'));

    // 证明这批默认权限**确实生效**了：迁移前建一个探针函数，anon 应该能执行它。
    // 没有这一步，下面的断言可能在「默认权限根本没生效」的情况下假通过。
    await db2.exec(`CREATE FUNCTION public.lf_probe_default_acl() RETURNS integer
                    LANGUAGE sql AS 'SELECT 1'`);
    const probe = await db2.query(
      `SELECT has_function_privilege('anon', 'public.lf_probe_default_acl()', 'EXECUTE') AS anon_exec`
    );
    assert.equal(probe.rows[0].anon_exec, true,
      '前提不成立：ALTER DEFAULT PRIVILEGES 没生效，这条回归就没有意义');
    await db2.exec('DROP FUNCTION public.lf_probe_default_acl()');

    await db2.exec(fs.readFileSync(MIGRATION, 'utf8'));
  });

  after(async () => { await db2.close(); });

  async function assertAcl(expectedMainOnly = true) {
    // 1) 逐函数用 has_function_privilege 判（这是「能不能调」的事实，不是看 ACL 文本）
    for (const sig of HELPER_SIGS) {
      for (const role of CLIENTS) {
        const r = await db2.query(
          `SELECT has_function_privilege($1, $2, 'EXECUTE') AS can`, [role, `public.${sig}`]
        );
        assert.equal(r.rows[0].can, false,
          `${role} 不应能执行 helper ${sig}（默认权限残留）`);
      }
    }
    for (const role of CLIENTS) {
      const r = await db2.query(
        `SELECT has_function_privilege($1, $2, 'EXECUTE') AS can`,
        [role, 'public.lf_search_text_v1(text,text[],integer)']
      );
      assert.equal(r.rows[0].can, expectedMainOnly, `${role} 对主函数的 EXECUTE 应为 ${expectedMainOnly}`);
    }

    // 2) ACL 文本里不许再出现客户端角色 / PUBLIC 的授权项
    const acl = await db2.query(
      `SELECT p.proname, coalesce(array_to_string(p.proacl, ' '), '(默认)') AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'lf\\_%'`
    );
    for (const r of acl.rows) {
      assert.notEqual(r.acl, '(默认)', `${r.proname} 仍是默认 ACL`);
      assert.doesNotMatch(r.acl, /(^|[ {,])=/, `${r.proname} 的 ACL 仍含 PUBLIC 授权：${r.acl}`);
      if (r.proname !== 'lf_search_text_v1') {
        assert.doesNotMatch(r.acl, /\b(anon|authenticated|service_role)=/,
          `${r.proname} 的 ACL 仍含客户端角色授权：${r.acl}`);
        assert.doesNotMatch(r.acl, /\b(?:anon|authenticated|service_role)\b/,
          `${r.proname} 的 ACL 仍提及客户端角色：${r.acl}`);
      }
    }
  }

  it('默认权限为 anon 预置 EXECUTE 时，迁移仍把 helper 收干净', async () => {
    await assertAcl(true);

    // 实际调用一次：anon 打 helper 必须 permission denied，打主函数必须成功
    await db2.exec('SET ROLE anon');
    try {
      await assert.rejects(() => db2.query("SELECT public.lf_dice_v1('耳机','耳机')"),
        /permission denied/i, 'anon 不该能直接调 lf_dice_v1');
      const ok = await db2.query(
        "SELECT count(*)::int AS n FROM public.lf_search_text_v1('耳机', '{}', 3)"
      );
      assert.ok(ok.rows[0].n >= 0, 'anon 仍应能调主函数');
    } finally {
      await db2.exec('RESET ROLE');
    }
  });

  it('重复执行迁移后结果不变（第二遍不会把权限放宽）', async () => {
    await db2.exec(fs.readFileSync(MIGRATION, 'utf8'));
    await assertAcl(true);

    // 再跑一遍，仍然一致
    await db2.exec(fs.readFileSync(MIGRATION, 'utf8'));
    await assertAcl(true);
  });
});
