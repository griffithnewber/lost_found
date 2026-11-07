-- 测试用最小 schema：字段类型/默认值与线上 lost_items 一致（2026-11-07 用 SQL 工具核对过）：
--   id            bigint GENERATED ALWAYS AS IDENTITY (PK)
--   title         text NOT NULL
--   created_at    timestamptz NOT NULL DEFAULT now()
--   status        text NOT NULL DEFAULT 'open'
--   post_type     text NOT NULL DEFAULT 'lost'
--   ai_tags       jsonb（数组）
--   color_feature jsonb
--   其余文本列可空
-- 线上还有 4 条 RLS 策略（read_all/insert_all/update_all/delete_all，grantee anon+authenticated），
-- 本文件不建策略：函数是 SECURITY DEFINER，测试只验证打分语义。
-- 测试库是裸 PostgreSQL，没有 Supabase/WorkBuddy 预置的角色；
-- 迁移文件里有 GRANT ... TO anon, authenticated, service_role，先把角色补齐。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;

DROP TABLE IF EXISTS lost_items;

CREATE TABLE lost_items (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title         text NOT NULL,
  detail        text,
  location      text,
  image         text,
  color_feature jsonb,
  pub_time      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  ai_desc       text,
  ai_tags       jsonb,
  status        text NOT NULL DEFAULT 'open',
  owner_id      text,
  claim_at      timestamptz,
  post_type     text NOT NULL DEFAULT 'lost',
  notice        text,
  category      text,
  color_tone    text,
  pickup_location text
);
