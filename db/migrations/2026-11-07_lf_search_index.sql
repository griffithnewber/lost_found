-- =====================================================================
-- 2026-11-07_lf_search_index.sql
--   文字检索候选池索引：ORDER BY created_at DESC, id DESC LIMIT 1000
--
-- 为什么需要（实测事实，不是猜测）：
--   lf_search_text_v1 的 cand CTE 每次都执行
--       SELECT ... FROM lost_items ORDER BY created_at DESC, id DESC LIMIT 1000
--   生产库 lost_items 上**只有主键索引**（pg_indexes 查过：lost_items_pkey），
--   created_at 上没有任何索引 → 每次都全表扫描 + Sort。
--   表还小的时候无所谓，记录一多就是每次检索一次全表排序。
--
-- 索引形态的选择：
--   (created_at DESC, id DESC) 与 ORDER BY 的列、方向、顺序完全一致，
--   可以直接走 Index Scan 取前 1000 行，不需要 Sort 节点。
--   只建 (created_at) 不够：同秒记录多时仍需在内存里对 id 排序，
--   而且和函数里的 tie-break 规则对不上。
--
-- ⚠️ 状态：**未在线上执行**。评估与验证在隔离库（PGlite）里做过，
--    结论见 docs/PLAN-TEXT-SEARCH-SQL.md「索引评估」。
--    生产执行前的注意事项：
--      1. CREATE INDEX 会短暂阻塞写入（小表可忽略）；若表已很大，
--         改用手工执行（CONCURRENTLY 不能放在事务块里，迁移器通常会包事务）：
--           CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lost_items_created_id_desc
--             ON public.lost_items (created_at DESC, id DESC);
--      2. 建完建议 ANALYZE public.lost_items; 让规划器立刻用上新索引。
-- =====================================================================

CREATE INDEX IF NOT EXISTS idx_lost_items_created_id_desc
  ON public.lost_items (created_at DESC, id DESC);

COMMENT ON INDEX public.idx_lost_items_created_id_desc IS
  '文字检索候选池：支撑 ORDER BY created_at DESC, id DESC LIMIT 1000（lf_search_text_v1）。';

-- 回滚：
--   DROP INDEX IF EXISTS public.idx_lost_items_created_id_desc;
