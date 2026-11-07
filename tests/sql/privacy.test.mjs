/**
 * tests/sql/privacy.test.mjs
 *
 * 目的：验证「关闭匿名 detail 直读」这件事真的成立，且没有把功能一起关掉。
 *
 * 场景按生产现状复刻：
 *   * 三个客户端角色存在；
 *   * lost_items 的表 owner 是一个**普通角色** app_owner（不是超级用户）；
 *   * 收紧前：anon 有**表级** SELECT/INSERT/UPDATE/DELETE（生产实测 relacl = anon=arwd）；
 *   * 收紧后（跑 2026-11-07_harden_public_columns.sql）：
 *       - detail / location / ai_desc / ai_tags 读不到
 *       - 公开列读得到
 *       - 写入仍然可以（写-only 列：登记表单要写 detail / location）
 *       - lf_search_text_v1 仍然能靠 SECURITY DEFINER 读到 detail 并给出加分
 *         （= 核验/匹配能力没有被权限收紧打死）
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
const HARDEN = path.join(ROOT, 'db', 'migrations', '2026-11-07_harden_public_columns.sql');
const SCHEMA = path.join(ROOT, 'tests', 'fixtures', 'schema_lost_items.sql');

const PUBLIC_COLS = 'id,title,image,color_feature,notice,category,color_tone,status,' +
  'post_type,owner_id,pickup_location,claim_at,pub_time,created_at';

describe('匿名隐私列收紧（detail / location / ai_desc / ai_tags）', () => {
  let db;

  before(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN;
      CREATE ROLE app_owner NOLOGIN;
    `);
    await db.exec(fs.readFileSync(SCHEMA, 'utf8'));
    await db.exec(fs.readFileSync(MIGRATION, 'utf8'));

    // 复刻生产 ACL：anon 拿整表读写（这正是缺口）
    await db.exec(`
      GRANT USAGE ON SCHEMA public TO anon, authenticated, app_owner;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.lost_items TO anon, authenticated;
      ALTER TABLE public.lost_items OWNER TO app_owner;
      -- 生产里整份迁移由同一个角色执行 → 所有 lf_* 函数同 owner。
      -- 这里必须一起改：helper 的 EXECUTE 只授给了 owner，owner 一旦分叉就会
      -- 出现 'permission denied for function lf_expand_v1'（见 PLAN 文档「迁移执行约定」）。
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
      `INSERT INTO lost_items (id, title, detail, location, notice, status, post_type,
                               category, color_tone, ai_desc, ai_tags, pickup_location, created_at)
       OVERRIDING SYSTEM VALUE
       VALUES (18, '粉色·证件卡', '学生证上面名字是：格里菲斯', '相山餐厅二楼 3 号桌',
               '相山餐厅二楼捡到一张粉色卡套的学生证', 'open', 'found',
               'card', 'pink', '一张粉色卡套学生证，卡套有卡通贴纸',
               '["贴纸","卡套"]'::jsonb, '一食堂门口服务台', now())`
    );
  });

  after(async () => { await db.close(); });

  it('收紧前：anon 能整表读（缺口是真实存在的，不是理论推演）', async () => {
    await db.exec('SET ROLE anon');
    try {
      const res = await db.query('SELECT detail, location FROM public.lost_items WHERE id = 18');
      assert.equal(res.rows[0].detail, '学生证上面名字是：格里菲斯');
      assert.equal(res.rows[0].location, '相山餐厅二楼 3 号桌');
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  it('执行收紧迁移后：detail / location / ai_desc / ai_tags 读不到', async () => {
    await db.exec('SET ROLE app_owner');
    try {
      await db.exec(fs.readFileSync(HARDEN, 'utf8'));
    } finally {
      await db.exec('RESET ROLE');
    }

    const priv = await db.query(
      `SELECT column_name, has_column_privilege('anon','public.lost_items',column_name,'SELECT') AS anon_ok,
              has_column_privilege('authenticated','public.lost_items',column_name,'SELECT') AS auth_ok
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='lost_items'
        ORDER BY ordinal_position`
    );
    const hidden = ['detail', 'location', 'ai_desc', 'ai_tags'];
    for (const r of priv.rows) {
      const expect = !hidden.includes(r.column_name);
      assert.equal(r.anon_ok, expect, `anon 对 ${r.column_name} 的 SELECT 应为 ${expect}`);
      assert.equal(r.auth_ok, expect, `authenticated 对 ${r.column_name} 的 SELECT 应为 ${expect}`);
    }

    // 表级 SELECT 必须已经收回（否则列级限制无效）
    const tbl = await db.query(
      `SELECT has_table_privilege('anon','public.lost_items','SELECT') AS tbl_sel`
    );
    assert.equal(tbl.rows[0].tbl_sel, false, '表级 SELECT 必须被收回');
  });

  it('anon 实读：公开列通过，隐藏列 / SELECT * 被拒', async () => {
    await db.exec('SET ROLE anon');
    try {
      const ok = await db.query(`SELECT ${PUBLIC_COLS} FROM public.lost_items WHERE id = 18`);
      assert.equal(ok.rows.length, 1);
      assert.equal(ok.rows[0].title, '粉色·证件卡');
      assert.equal(ok.rows[0].pickup_location, '一食堂门口服务台');
      assert.equal(Object.prototype.hasOwnProperty.call(ok.rows[0], 'detail'), false);

      await assert.rejects(
        () => db.query('SELECT detail FROM public.lost_items WHERE id = 18'),
        /permission denied/i, 'detail 仍可读 → 收紧失败'
      );
      await assert.rejects(
        () => db.query('SELECT location FROM public.lost_items WHERE id = 18'),
        /permission denied/i, 'location 仍可读 → 收紧失败'
      );
      await assert.rejects(
        () => db.query('SELECT * FROM public.lost_items WHERE id = 18'),
        /permission denied/i, 'SELECT * 必须失败（api.js 已改成显式列）'
      );
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  it('写入没被弄坏：anon 仍能写 detail / location（写-only）', async () => {
    await db.exec('SET ROLE anon');
    try {
      const ins = await db.query(
        `INSERT INTO public.lost_items (title, detail, location, notice, status, post_type)
         VALUES ('测试·耳机', '测试细节', '测试地点', '测试公开说明', 'open', 'found')
         RETURNING id, title, status`
      );
      assert.equal(ins.rows[0].title, '测试·耳机');
      // RETURNING * 应当失败（anon 不能读隐藏列），这也是 api.js 必须显式 .select(PUBLIC_COLS) 的原因
      await assert.rejects(
        () => db.query(
          `INSERT INTO public.lost_items (title, status, post_type)
           VALUES ('测试2', 'open', 'found') RETURNING *`
        ),
        /permission denied/i, 'RETURNING * 应失败'
      );
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  it('检索/核验能力没被权限收紧打死：anon 调函数仍能用到 detail 加分', async () => {
    const Q = '写有名字的证件卡';
    // 只算公开字段的 baseline（detail 不参与）—— 这一步用 owner 身份算，
    // anon 没有 lf_dice_v1 的 EXECUTE（见 permissions.test.mjs）
    const base = Number((await db.query(
      `SELECT public.lf_dice_v1(public.lf_expand_v1($1) || ' ',
                                 public.lf_haystack_v1(title, color_tone, category, notice, ai_tags)) AS v
         FROM public.lost_items WHERE id = 18`, [Q]
    )).rows[0].v);
    const sec = Number((await db.query(
      'SELECT public.lf_dice_v1($1, $2) AS v', [Q, '学生证上面名字是：格里菲斯']
    )).rows[0].v);
    assert.ok(sec > 0.1, `用例前提：detail 命中需超过 0.1，实际 ${sec}`);
    assert.ok(base > 0.05, `用例前提：公开字段 base 需超过 0.05，实际 ${base}`);

    await db.exec('SET ROLE anon');
    try {
      const res = await db.query(
        `SELECT id, score, level, label FROM public.lf_search_text_v1('${Q}', '{}', 5)`
      );
      assert.ok(res.rows.length > 0, 'anon 应能检索到结果');
      const hit = res.rows.find((r) => Number(r.id) === 18);
      assert.ok(hit, 'LF-18 应在结果里');
      const expect = Math.min(1, base + sec * 0.9);
      assert.ok(Math.abs(Number(hit.score) - expect) < 1e-9,
        `detail 加分应生效：期望 ${expect}，实际 ${hit.score}（base=${base} sec=${sec}）`);
      assert.equal(Object.prototype.hasOwnProperty.call(hit, 'detail'), false, '函数不得返回 detail');
      console.log(`  [隐私] anon 检索 score=${Number(hit.score).toFixed(4)} = base ${base.toFixed(4)} + sec ${sec.toFixed(4)}*0.9，detail 未外泄`);
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  it('owner（阿寻通道）不受影响：仍能按编号读 detail', async () => {
    await db.exec('SET ROLE app_owner');
    try {
      const res = await db.query('SELECT detail, location FROM public.lost_items WHERE id = 18');
      assert.equal(res.rows[0].detail, '学生证上面名字是：格里菲斯');
    } finally {
      await db.exec('RESET ROLE');
    }
  });
});
