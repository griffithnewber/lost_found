-- =====================================================================
-- 2026-11-09_map_area.sql
--   地图模块的数据层：给物品加「七区枚举」公开列，给寄存点挂区域。
--   设计文档：docs/PLAN-MAP-MODULE.md
--
-- 为什么是 area 而不是坐标：
--   * 2026-11-07 起网页对 location 列没有 SELECT（harden 迁移），那是
--     防冒领设计，不能为地图开倒车；
--   * ROADMAP 合规红线：精确坐标不入公开数据库；
--   * 地图只需要「哪个区域」的粗粒度信息 → 七区枚举 text 列，
--     网页上 emoji 标记落在区域锚点四周（散开防重叠），不需要真坐标。
--
-- 七区（唯一事实源是 assets/zones.js，SQL/前端/阿寻提示词三处一致）：
--   east_teaching 东教学楼群 / west_teaching 西教学楼群
--   east_playground 东操场   / west_playground 西操场
--   east_dorm 东园宿舍       / west_dorm 西园宿舍
--   gym 体育馆
--
-- ⚠️ 状态：**已在线上执行**（2026-11-09，逐条通过 db_exec_sql，全部成功）。
--    执行顺序 = 本文出现顺序：加列 → 授权 → 回填 → 寄存点种子数据。
--    上线顺序必须是「迁移 → 前端 → 阿寻提示词」，反过来会 42703。
-- =====================================================================

-- §1 加列（可 NULL：老记录没回填的进地图「未定位」收纳点，不丢数据）
ALTER TABLE public.lost_items  ADD COLUMN IF NOT EXISTS area text;
ALTER TABLE public.locations   ADD COLUMN IF NOT EXISTS zone text;

-- §2 授权给网页（漏了这步前端一查就 401，harden 迁移的同款坑）
GRANT SELECT (area) ON TABLE public.lost_items TO anon, authenticated;
GRANT SELECT (zone) ON TABLE public.locations  TO anon, authenticated;

-- §3 回填（按 notice/pickup_location 关键词，宁缺勿错）。
--    线上执行时只确定了两条：
UPDATE lost_items SET area='east_dorm'        WHERE id=34 AND area IS NULL;  -- 「东区宿舍6楼」→ 东园宿舍
UPDATE lost_items SET area='east_playground'  WHERE id=18 AND area IS NULL;  -- 「操场东侧看台」→ 东操场
-- LF-30「女生宿舍楼」东西不明、LF-17 快递站、LF-16 相山餐厅不在七区 → 留 NULL。

-- §4 七大区寄存点种子数据（学校保卫部门官方寄存点，zone 唯一防重插）。
--    原有 3 行（一食堂/图书馆/快递站）zone 留 NULL：地图上不画，卡片上的
--    📍 pickup 标签照常显示。
INSERT INTO locations (name, address, open_hours, zone)
SELECT v.name, v.address, v.open_hours, v.zone
FROM (VALUES
  ('东教学楼群寄存点','东教学楼群一层值班点','以保卫处公告为准','east_teaching'),
  ('西教学楼群寄存点','西教学楼群一层值班点','以保卫处公告为准','west_teaching'),
  ('东操场寄存点','东操场器材室旁','以保卫处公告为准','east_playground'),
  ('西操场寄存点','西操场器材室旁','以保卫处公告为准','west_playground'),
  ('东园宿舍寄存点','东园宿舍一层值班点','以保卫处公告为准','east_dorm'),
  ('西园宿舍寄存点','西园宿舍一层值班点','以保卫处公告为准','west_dorm'),
  ('体育馆寄存点','体育馆一层服务台','以保卫处公告为准','gym')
) AS v(name, address, open_hours, zone)
WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.zone = v.zone);

-- §5 阿寻侧（提示词 v1.17.0，另见 agents/lost-found-assistant.md）：
--    登记时地点拆两问（先七区确认、再楼栋楼层），INSERT 参数表加 area。
--    注意阿寻的公开 REST 通道也能写 area（列对公开密钥只撤了读，写没撤）。
