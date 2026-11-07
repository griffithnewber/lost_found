-- =====================================================================
-- 2026-11-07_harden_public_columns.sql
--   关闭「匿名直读隐藏字段」：从 anon / authenticated 收回整表 SELECT，
--   改成逐列授权，把 detail / location / ai_desc / ai_tags 挡在列权限外。
--
-- 背景（生产实测，2026-11-07）：
--   lost_items.relacl = {anon=arwd/...}   ← 表级 SELECT，等于 18 列全开
--   anon 只要拿到网页里那串公开访问密钥（它本来就发给每个访客），
--   就能直接 GET /rest/lost_items?select=*，把每条记录的 detail 整列读走。
--   detail 是「只有失主才写得出」的核验依据（学生证上的名字、划痕位置…），
--   被读走等于核验失效、冒领可照着编。location（具体存放位置）同理。
--   api.js 的注释一直写着「detail / location 为隐藏字段」，但权限层面
--   从来没关过 —— 这是上线阻断项，不是"以后再说"。
--
-- 做法：
--   1. 收回表级 SELECT（表级 SELECT 一旦存在，列级限制无效）；
--   2. 按列重新授权「网页真的会用到的字段」；
--   3. **INSERT / UPDATE / DELETE 保持原样**：登记表单要写 detail 和 location，
--      写-only 的列不构成泄漏面（能写不能读）；
--   4. service_role 不动（它本来就是服务端角色，不是浏览器能拿到的身份）。
--
-- 影响面（逐条核过代码，见 docs/PLAN-TEXT-SEARCH-SQL.md「隐私缺口」）：
--   * 广场 / 我的发布 / 留言：只用 id,title,image,notice,category,color_tone,
--     status,post_type,pub_time,pickup_location,owner_id → 全部仍在授权内
--   * 按编号查询（LF.api.findItemById）：改成显式列，不再 select('*')
--   * 网页核验（assets/ai.js 的 makeQuestion/judgeAnswer）：**本来就是死代码**
--     （全仓库无调用方，核验已迁到阿寻），已删除，不再需要 detail
--   * 阿寻：走 workbuddy_cloudservice_db_exec_sql，执行身份是库 owner
--     （current_user = cloudbase_postgres_postgres_…，非超级用户但属主），
--     不受本文件影响 —— 核验用的单条 detail 查询照旧可用
--
-- ⚠️ 状态：**未在线上执行**。执行前必须先让 api.js 的新版本上线
--    （旧版 api.js 的 select('*') / 缓存回填会被拒，实测 HTTP 401 + DATABASE_42501），顺序见文末。
-- =====================================================================

-- §1 先收回整表读权限
REVOKE SELECT ON TABLE public.lost_items FROM anon, authenticated;

-- §2 再逐列授权（只给网页真正渲染的字段）
GRANT SELECT (
  id,             -- 编号
  title,          -- 「颜色·类别」
  image,          -- 照片（等价于广场已公开的图片本身）
  color_feature,  -- 主色特征（发图时写入；不含任何文字信息）
  notice,         -- 公开说明
  category,
  color_tone,
  status,         -- open / claimed / returned
  post_type,      -- found / lost
  owner_id,       -- 「我的发布」归属判断
  pickup_location,-- 寄存点名称（公开信息，用来约交接）
  claim_at,
  pub_time,
  created_at
) ON TABLE public.lost_items TO anon, authenticated;

-- 明确不授权（留此说明，防止以后有人「顺手」补上）：
--   detail   隐藏细节，只有失主写得出，是核验依据
--   location 具体存放位置，只在服务端匹配/核验时用
--   ai_desc  AI 对照片的文字描述，可反推出图案/配件等隐藏特征
--   ai_tags  同上（JSON 数组）


-- ---------------------------------------------------------------------
-- §3 验证（在生产执行后逐条跑，全部应为预期值）
-- ---------------------------------------------------------------------
-- 3.1 列权限矩阵：detail/location/ai_desc/ai_tags 不应出现在 anon 名下
--   SELECT grantee, string_agg(column_name, ',' ORDER BY column_name) AS cols
--     FROM information_schema.column_privileges
--    WHERE table_schema='public' AND table_name='lost_items'
--      AND privilege_type='SELECT' AND grantee IN ('anon','authenticated')
--    GROUP BY grantee;
--   -- 期望 14 列，且不含上面 4 个
--
-- 3.2 以 anon 身份实跑（会 SET ROLE，必须在测试库做，不要在生产跑）
--      注：走 REST 时列权限被拒返回 **401**（anon 是 no-privilege 角色）+ code DATABASE_42501，
--      不是 403；判定请用「401/403 + 响应体 permission denied」，2026-11-07 实测。
--   SET ROLE anon;
--   SELECT id, title FROM public.lost_items LIMIT 1;        -- 通过
--   SELECT detail FROM public.lost_items LIMIT 1;            -- 期望 permission denied for table lost_items
--   SELECT * FROM public.lost_items LIMIT 1;                 -- 期望 permission denied
--   SELECT * FROM public.lf_search_text_v1('耳机', '{}', 3); -- 通过（DEFINER）
--   RESET ROLE;
--
-- 3.3 写入不被破坏
--   SET ROLE anon;
--   INSERT INTO public.lost_items (title, detail, location, status, post_type)
--   VALUES ('测试·耳机', '测试细节', '测试地点', 'open', 'found')
--   RETURNING id, title;                                     -- 通过（写-only 列）
--   RESET ROLE;
--   -- 清理：DELETE FROM public.lost_items WHERE title='测试·耳机';


-- ---------------------------------------------------------------------
-- §4 上线顺序（顺序错了会白屏）
--   1. 前端先上：api.js 改成显式列 + 缓存换 key（已在本分支改好，等发布）；
--   2. 再跑本文件；
--   3. 立刻验证 3.1 / 3.2 / 3.3，以及网页广场、我的发布、按编号绑定三条路径；
--   4. 观察 24h：PostgREST 里任何 `select=*` 残留都会被拒（401/403），
--      日志筛 `permission denied for table lost_items` 即可确认干不干净。
--
-- 回滚（权限可以精确还原，不影响数据）：
--   GRANT SELECT ON TABLE public.lost_items TO anon, authenticated;
--   -- 逐列授权会被表级授权覆盖，可留可清：
--   REVOKE SELECT (detail, location, ai_desc, ai_tags) ON TABLE public.lost_items
--     FROM anon, authenticated;   -- 注意：表级 SELECT 在时这条是空操作，回滚即恢复旧状态
-- =====================================================================
