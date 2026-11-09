-- =====================================================================
-- 2026-11-07_lf_search_text_v1.sql
--   失物招领「文字检索」共享函数：网页与阿寻（智能体）调用同一个实现
--
-- 移植来源（仓库 main 已删除，取自 cc9e40de76bc6736d89e17e78ecd0cf877b5ade7）：
--   assets/search.js   LF.search.text()   —— 同义词扩展 / 2-gram / Dice / 加分
--   assets/match.js    LF.match.annotate() —— 0.5 / 0.25 分级与 label 文案
--   assets/config.js   类别与主色调的 label 字典（历史版本，见下方 §4）
--
-- algorithm_version 常量：'lf-text-v1@cc9e40d'
--
-- 语义保持清单（逐条对照历史 JS，勿"顺手优化"）：
--   * 同义词扩展只在 query 侧与 haystack 侧各做一次（expand 幂等，重复调用无害）
--   * n-gram 按 **UTF-16 code unit** 切分（与 JS string.length / slice 完全一致，
--     见 §2 与 §2b），emoji 与汉字相邻时同样逐 unit 切开 —— 这是本轮修正的重点：
--     v0 按 Unicode 码点切分，与历史 JS 不等价，已作废
--   * 候选池 = created_at DESC 的前 1000 条，**先取 1000 再**剔除 returned
--     （claimed 保留；found / lost 两种 post_type 都保留）
--   * 阈值：过滤 score > 0.08；分级 high = score >= 0.5、mid = score >= 0.25
--   * 加分封顶：min(关键词命中数 * 0.05 + 标题奖励 0.15, 0.3)
--   * 隐藏细节：sec = dice(原始小写 query, detail)；
--     sec > 0 才叠加 关键词命中数 * 0.15（封顶 1）；
--     仅当 sec > 0.1 且 base > 0.05 时生效，weight 0.9，结果 min(1, ...)
--   * 分数不额外截断到 1（历史实现允许 > 1 的分数）
--   * 无地点 / 时间加权（历史算法没有，不要补）
--
-- 与历史 JS 的关系（本轮已对齐，不再有"算法差异"）：
--   1) n-gram：等价。tests/sql/lf_search_parity.test.mjs 用 emoji 相邻用例逐分对照。
--   2) 同分排序：历史 JS 依赖 Array.prototype.sort 的稳定性（V8 稳定排序），
--      等价于「保持入参顺序」；入参顺序本来就是 created_at DESC。
--      **SQL 侧显式写成 ORDER BY score DESC, created_at DESC, id DESC**，
--      这是本轮新增的确定性规则（规格新增项，非历史行为）：
--      同一秒创建的两条记录，历史 JS 的顺序其实取决于数据库返回顺序，
--      现在固定为 id 大者在前，可复现。JS 对照测试喂给历史实现前，
--      也按同一顺序排好候选（tests/lib/corpus.mjs legacyCandidates）。
--   3) 类别/颜色字典固定为 cc9e40d 版本；现行新增的 wallet / glasses /
--      brown / purple / clear 在该字典中无 label，会退化为不追加 label
--      （与历史 JS 行为一致）。要覆盖它们只能走 v2，不要改 v1 ——
--      改了 v1 历史分数就不可复现了。
--
-- 返回列（只给公开字段）：id / title / category / color_tone / notice /
--   status / post_type / pub_time / pickup_location + score / level / label /
--   rank / algorithm_version。
--   **不含 detail、location、ai_desc、ai_tags**：
--     detail   = 隐藏细节，仅在函数内部参与计算；
--     location = 具体存放位置，只在服务端（阿寻按编号查）使用，不发给浏览器；
--     ai_desc / ai_tags = AI 对照片的解读，属于可反推出隐藏特征的中间产物。
--
-- 权限（§8）：主函数 SECURITY DEFINER，owner = lost_items 表 owner
--   （实测该角色 rolsuper=false / rolbypassrls=true，不是超级用户）；
--   helper 一律不授权给客户端角色。不放宽到 superuser，也不用管理员身份兜底。
--
-- ✅ 执行状态：2026-11-09 已在应用 wbapp_7WvCzu8yW3N6uppqR8xFUp 的云库执行
--    （逐条语句下发，9 个函数全部创建；pg_get_functiondef 的 md5 与旧环境逐一相同，
--     检索结果逐分对照一致）。执行位置与核对方式见 docs/PLAN-TEXT-SEARCH-SQL.md。
--    注意：执行通道一次只能下发**一条** SQL 语句，故按 §1…§8 顺序分开执行；
--    本文件本身仍是完整、可重复执行（CREATE OR REPLACE）的版本。
-- =====================================================================


-- ---------------------------------------------------------------------
-- §1 同义词表（逐字照抄 assets/search.js 的 SYNONYMS，键顺序也必须一致）
--    顺序敏感：expand() 是按插入顺序对「已增长的字符串」逐个判断包含关系的。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lf_expand_v1(p_text text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $lf$
DECLARE
  t text := lower(coalesce(p_text, ''));
BEGIN
  -- 键顺序：伞, 书包, 手机, 钥匙, 钱包, 耳机, 水杯, 电脑, 黑色, 蓝色, 白色, 红色
  IF position('伞'   IN t) > 0 THEN t := t || ' ' || '雨伞 遮阳伞 umbrella';   END IF;
  IF position('书包' IN t) > 0 THEN t := t || ' ' || '背包 双肩包 包';          END IF;
  IF position('手机' IN t) > 0 THEN t := t || ' ' || '电话 iphone 安卓机';      END IF;
  IF position('钥匙' IN t) > 0 THEN t := t || ' ' || '钥匙串 key';             END IF;
  IF position('钱包' IN t) > 0 THEN t := t || ' ' || '皮夹 钱夹';               END IF;
  IF position('耳机' IN t) > 0 THEN t := t || ' ' || '蓝牙耳机 耳麦 airpods 无线耳机'; END IF;
  IF position('水杯' IN t) > 0 THEN t := t || ' ' || '杯子 保温杯 水壶';        END IF;
  IF position('电脑' IN t) > 0 THEN t := t || ' ' || '笔记本 laptop macbook';   END IF;
  IF position('黑色' IN t) > 0 THEN t := t || ' ' || '黑 深色';                 END IF;
  IF position('蓝色' IN t) > 0 THEN t := t || ' ' || '蓝 深蓝';                 END IF;
  IF position('白色' IN t) > 0 THEN t := t || ' ' || '白 浅色';                 END IF;
  IF position('红色' IN t) > 0 THEN t := t || ' ' || '红';                     END IF;
  RETURN t;
END
$lf$;

COMMENT ON FUNCTION public.lf_expand_v1(text) IS
  '文字检索 v1：同义词扩展，逐字移植 search.js expand()；键顺序敏感。';


-- ---------------------------------------------------------------------
-- §2 UTF-16 code unit 序列
--
-- 历史 JS 的 ngrams() 用 t.length / t.slice(i, i+2) —— 这两个 API 都按
-- **UTF-16 code unit** 计数，不按 Unicode 码点。差异只在星平面字符
-- （emoji 等，一个码点 = 两个 unit）出现时暴露：
--     '杯子😀'  JS 长度 4 → gram: [杯子] [子+高代理] [高代理+低代理]
--               PG 码点长度 3 → gram: [杯子] [子😀]
-- 要让 SQL 与 JS 完全等价，就必须先展开成 UTF-16 code unit 数组再两两配对。
--
-- ⚠️ 不用 convert_to(x,'UTF16')：实测 PGlite 的编码表里没有 UTF16
--    （invalid destination encoding name），且该转换还会受服务端编码影响。
--    这里用 ascii() 取码点（UTF8 库返回 Unicode 码点），再手工做
--    UTF-16 代理对拆分：cp > 0xFFFF → 高代理 D800 + (cp-0x10000)>>10，
--    低代理 DC00 + (cp-0x10000)&0x3FF。纯整数运算，无编码依赖。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lf_u16_units_v1(p_text text)
RETURNS integer[]
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $lf$
DECLARE
  res integer[] := '{}'::integer[];
  c   text;
  cp  integer;
BEGIN
  IF p_text IS NULL OR p_text = '' THEN
    RETURN res;
  END IF;
  FOREACH c IN ARRAY regexp_split_to_array(p_text, '') LOOP
    cp := ascii(c);                       -- UTF8 库：返回该字符的 Unicode 码点
    IF cp > 65535 THEN
      res := res || (55296 + ((cp - 65536) >> 10));    -- 0xD800 高代理
      res := res || (56320 + ((cp - 65536) & 1023));   -- 0xDC00 低代理
    ELSE
      res := res || cp;
    END IF;
  END LOOP;
  RETURN res;
END
$lf$;

COMMENT ON FUNCTION public.lf_u16_units_v1(text) IS
  '文字检索 v1：把 text 展开成 UTF-16 code unit 整数数组（星平面字符拆成代理对），与 JS string.length 等价。';


-- ---------------------------------------------------------------------
-- §2b 清洗 + 2-gram 集合（Set 语义：去重）
--     历史 JS 先 expand，再去掉 \s 与 ，。,.!?！？、；;：:"'（）()【】[]
--     PG 的 [:space:] 与 JS \s 不完全等价，故显式补上其余 Unicode 空白字符。
--
--     gram 的表示：两个 code unit 各取 4 位大写十六进制再拼接（8 字符）。
--     例：'杯子' → ['676F5B50']（676F='杯', 5B50='子'），'😀' → ['D83DDE00']。
--     用十六进制而不是还原成字符，是因为「子+高代理」这种半个代理对
--     在 text 里根本无法表示（不是合法 UTF-16）；十六进制对是双射，
--     集合交并集的语义与 JS Set<string> 完全一致。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lf_bigrams_v1(p_text text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $lf$
DECLARE
  t     text;
  v_ws  text := '';
  i     integer;
  u     integer[];
  n     integer;
  res   text[] := '{}'::text[];
BEGIN
  -- 与 JS \s 对齐的额外空白：U+00A0, U+1680, U+2000..200A, U+2028, U+2029,
  -- U+202F, U+205F, U+3000, U+FEFF
  v_ws := chr(160) || chr(5760) || chr(8232) || chr(8233) || chr(8239)
          || chr(8287) || chr(12288) || chr(65279);
  FOR i IN 8192..8202 LOOP
    v_ws := v_ws || chr(i);
  END LOOP;

  t := regexp_replace(public.lf_expand_v1(p_text), '[[:space:]]', '', 'g');
  t := translate(t, '，。,.!?！？、；;：:"''（）()【】[]' || v_ws, '');

  u := public.lf_u16_units_v1(t);
  n := coalesce(array_length(u, 1), 0);

  IF n = 0 THEN
    RETURN res;                                    -- 同 JS：空串 → 空集合
  END IF;
  IF n < 2 THEN
    -- 同 JS：t.length < n 时把整串当一个 gram（单 unit）
    RETURN ARRAY[lpad(upper(to_hex(u[1])), 4, '0')];
  END IF;

  FOR i IN 1..(n - 1) LOOP
    res := res || (lpad(upper(to_hex(u[i])), 4, '0')
                   || lpad(upper(to_hex(u[i + 1])), 4, '0'));
  END LOOP;

  RETURN ARRAY(SELECT DISTINCT x FROM unnest(res) AS g(x));
END
$lf$;

COMMENT ON FUNCTION public.lf_bigrams_v1(text) IS
  '文字检索 v1：按 UTF-16 code unit 切 2-gram 去重集合（gram=两个 unit 的 4 位十六进制拼接）；长度<2 时退化为整串。';


-- ---------------------------------------------------------------------
-- §3 Dice 系数（集合交并比）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lf_dice_v1(p_a text, p_b text)
RETURNS double precision
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $lf$
DECLARE
  sa     text[] := public.lf_bigrams_v1(p_a);
  sb     text[] := public.lf_bigrams_v1(p_b);
  na     integer;
  nb     integer;
  inter  integer;
BEGIN
  na := coalesce(array_length(sa, 1), 0);
  nb := coalesce(array_length(sb, 1), 0);
  IF na = 0 OR nb = 0 THEN
    RETURN 0::double precision;         -- 同 JS：!A.size || !B.size -> 0
  END IF;
  SELECT count(*)::integer INTO inter FROM unnest(sa) AS x(g) WHERE x.g = ANY (sb);
  RETURN (2.0 * inter) / (na + nb);
END
$lf$;

COMMENT ON FUNCTION public.lf_dice_v1(text, text) IS
  '文字检索 v1：Dice = 2*交集 / (|A|+|B|)，集合语义，空集返回 0。';


-- ---------------------------------------------------------------------
-- §4 label 字典快照（assets/config.js @ cc9e40d）
--    未知 key 返回空串，与 LF.ui.categoryMeta()/toneMeta() 的 fallback 一致
--    → 会被 haystack 的 filter(Boolean) 丢掉。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lf_category_label_v1(p_category text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $lf$
  SELECT CASE p_category
    WHEN 'headphones' THEN '耳机'
    WHEN 'cup'        THEN '水杯'
    WHEN 'umbrella'   THEN '雨伞'
    WHEN 'card'       THEN '证件卡'
    WHEN 'keys'       THEN '钥匙'
    WHEN 'bag'        THEN '书包/背包'
    WHEN 'phone'      THEN '手机/电子设备'
    WHEN 'book'       THEN '书/笔记本'
    WHEN 'clothes'    THEN '衣物'
    WHEN 'other'      THEN '其他'
    ELSE ''
  END
$lf$;

CREATE OR REPLACE FUNCTION public.lf_color_label_v1(p_color_tone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $lf$
  SELECT CASE p_color_tone
    WHEN 'black'  THEN '黑色'
    WHEN 'white'  THEN '白色'
    WHEN 'gray'   THEN '灰色'
    WHEN 'blue'   THEN '蓝色'
    WHEN 'red'    THEN '红色'
    WHEN 'pink'   THEN '粉色'
    WHEN 'green'  THEN '绿色'
    WHEN 'yellow' THEN '黄色'
    WHEN 'other'  THEN '其他颜色'
    ELSE ''
  END
$lf$;

COMMENT ON FUNCTION public.lf_category_label_v1(text) IS
  '文字检索 v1：类别 label 快照（cc9e40d）。wallet/glasses 等后加类别不在快照内 → 返回空串。';
COMMENT ON FUNCTION public.lf_color_label_v1(text) IS
  '文字检索 v1：主色调 label 快照（cc9e40d）。brown/purple/clear 等后加颜色不在快照内 → 返回空串。';


-- ---------------------------------------------------------------------
-- §5 ai_tags（jsonb 数组）-> 空格串
--    同 JS：Array.isArray ? join(' ') : ''
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lf_ai_tags_text_v1(p_tags jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $lf$
DECLARE
  res text;
BEGIN
  IF p_tags IS NULL OR jsonb_typeof(p_tags) <> 'array' THEN
    RETURN '';
  END IF;
  SELECT coalesce(string_agg(x.v, ' '), '') INTO res
    FROM jsonb_array_elements_text(p_tags) AS x(v);
  RETURN coalesce(res, '');
END
$lf$;

COMMENT ON FUNCTION public.lf_ai_tags_text_v1(jsonb) IS
  '文字检索 v1：ai_tags 数组拼成空格串（非数组/空 → 空串）。';


-- ---------------------------------------------------------------------
-- §6 haystack：参与打分的公开文本
--    历史顺序（search.js haystack）：title, tone.label, category.label, notice, ai_tags
--    注意：ai_desc 不参与文字检索（历史实现里只有图片检索用它）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lf_haystack_v1(
  p_title      text,
  p_color_tone text,
  p_category   text,
  p_notice     text,
  p_ai_tags    jsonb
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $lf$
DECLARE
  parts text[] := '{}'::text[];
  tone  text := public.lf_color_label_v1(p_color_tone);
  cat   text := public.lf_category_label_v1(p_category);
  tags  text;
BEGIN
  IF coalesce(p_title, '') <> '' THEN parts := parts || p_title; END IF;
  IF tone <> '' THEN parts := parts || tone; END IF;
  IF cat  <> '' THEN parts := parts || cat;  END IF;
  IF coalesce(p_notice, '') <> '' THEN parts := parts || p_notice; END IF;
  tags := public.lf_ai_tags_text_v1(p_ai_tags);
  IF tags <> '' THEN parts := parts || tags; END IF;
  RETURN array_to_string(parts, ' ');
END
$lf$;

COMMENT ON FUNCTION public.lf_haystack_v1(text, text, text, text, jsonb) IS
  '文字检索 v1：打分用公开文本（title + 颜色 label + 类别 label + notice + ai_tags）。';


-- ---------------------------------------------------------------------
-- §7 主函数
--    返回：公开字段 + score / level / label / rank / algorithm_version
--    私有字段（detail / location / ai_desc / ai_tags）只在函数内部使用，绝不返回
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lf_search_text_v1(
  p_query    text,
  p_keywords text[]  DEFAULT '{}'::text[],
  p_limit    integer DEFAULT 20
)
RETURNS TABLE (
  id                bigint,
  title             text,
  category          text,
  color_tone        text,
  notice            text,
  status            text,
  post_type         text,
  pub_time          text,
  pickup_location   text,
  score             double precision,
  level             text,
  label             text,
  rank              integer,
  algorithm_version text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
-- 只留 pg_catalog：public 已实测不给 PUBLIC 建对象权限，但没必要把它放进
-- DEFINER 函数的搜索路径 —— 下面所有自有对象都显式 public. 限定，
-- 攻击者即使将来拿到 public 的 CREATE 也无法劫持解析。
SET search_path = pg_catalog
AS $lf$
DECLARE
  -- 输入契约（v1，两端统一）：只 trim，不改写。
  -- 网页在 api.js 里 trim 一次，这里再 trim 一次 —— 目的是让「用 REST 直接打
  -- 函数、忘了 trim」的调用方也得到同一结果（历史 JS 的 bigram 本来就会去掉
  -- 空白，但 title 奖励用 indexOf，首尾空格会让 0.15 奖励悄悄失效）。
  --    注意 btrim 默认只去空格，制表/换行/全角空格要显式列出来（JS 的 trim 都会去）。
  v_query    text    := btrim(coalesce(p_query, ''),
                              ' ' || chr(9) || chr(10) || chr(13) || chr(12) || chr(11) || chr(12288));
  v_keywords text[]  := coalesce(p_keywords, '{}'::text[]);
  v_limit    integer := greatest(0, least(coalesce(p_limit, 20), 200));
  v_qexp     text;
  v_qlower   text;
BEGIN
  -- JS：qExpanded = expand(query) + ' ' + keywords.join(' ')
  v_qexp   := public.lf_expand_v1(v_query) || ' ' || coalesce(array_to_string(v_keywords, ' '), '');
  -- JS：qLower = String(query||'').toLowerCase()（不扩展，用于 detail 比对）
  v_qlower := lower(v_query);

  RETURN QUERY
  WITH cand AS (
    -- 候选：最新 1000 条（先取后过滤，顺序与历史实现一致）
    -- 依赖索引 idx_lost_items_created_id_desc，见 2026-11-07_lf_search_index.sql
    SELECT i.id, i.title, i.category, i.color_tone, i.notice,
           i.status, i.post_type, i.pub_time, i.pickup_location,
           i.detail, i.ai_tags, i.created_at   -- detail / ai_tags 仅内部使用，不进返回列
      FROM public.lost_items AS i
     ORDER BY i.created_at DESC, i.id DESC
     LIMIT 1000
  ),
  live AS (
    -- 只剔除 returned；claimed 与两种 post_type 都保留
    SELECT c.*,
           public.lf_haystack_v1(c.title, c.color_tone, c.category, c.notice, c.ai_tags) AS hay
      FROM cand AS c
     WHERE c.status <> 'returned'
  ),
  calc AS (
    SELECT l.*,
           public.lf_dice_v1(v_qexp, l.hay) AS base,
           (SELECT count(*)
              FROM unnest(v_keywords) AS k(v)
             WHERE coalesce(k.v, '') <> ''
               AND position(lower(k.v) IN lower(l.hay)) > 0)::double precision AS kw_hits,
           CASE WHEN coalesce(l.title, '') <> ''
                     AND v_query <> ''
                     AND position(v_query IN l.title) > 0
                THEN 0.15::double precision ELSE 0::double precision END AS title_bonus,
           CASE WHEN coalesce(l.detail, '') <> ''
                THEN public.lf_dice_v1(v_qlower, l.detail) ELSE 0::double precision END AS sec_base,
           (SELECT count(*)
              FROM unnest(v_keywords) AS k(v)
             WHERE coalesce(k.v, '') <> ''
               AND position(lower(k.v) IN lower(coalesce(l.detail, ''))) > 0)::double precision AS sec_kw
      FROM live AS l
  ),
  secs AS (
    -- JS：if (detail && sec > 0) sec = Math.min(1, sec + secKW * 0.15)
    SELECT c.*,
           CASE WHEN c.sec_base > 0
                THEN least(1.0, c.sec_base + c.sec_kw * 0.15)
                ELSE 0::double precision END AS sec
      FROM calc AS c
  ),
  scored AS (
    -- JS：score = base + Math.min(bonus, 0.3)，bonus = kw*0.05 + title*0.15
    SELECT s.*,
           (s.base + least(s.kw_hits * 0.05 + s.title_bonus, 0.3)) AS s0
      FROM secs AS s
  ),
  final AS (
    -- JS：if (sec > 0.1 && base > 0.05) score = Math.min(1, score + sec * 0.9)
    SELECT s.*,
           CASE WHEN s.sec > 0.1 AND s.base > 0.05
                THEN least(1.0, s.s0 + s.sec * 0.9)
                ELSE s.s0 END AS sfinal
      FROM scored AS s
  )
  SELECT f.id,
         f.title,
         f.category,
         f.color_tone,
         f.notice,
         f.status,
         f.post_type,
         f.pub_time,
         f.pickup_location,
         f.sfinal AS score,
         CASE WHEN f.sfinal >= 0.5 THEN 'high'
              WHEN f.sfinal >= 0.25 THEN 'mid'
              ELSE 'low' END AS level,
         (CASE WHEN f.sfinal >= 0.5 THEN '很可能就是它 · '
               WHEN f.sfinal >= 0.25 THEN '有点接近 · '
               ELSE '参考项 · ' END)
           || floor(f.sfinal * 100 + 0.5)::integer::text || '%' AS label,
         (row_number() OVER (ORDER BY f.sfinal DESC, f.created_at DESC, f.id DESC))::integer AS rank,
         'lf-text-v1@cc9e40d'::text AS algorithm_version
    FROM final AS f
   WHERE f.sfinal > 0.08                 -- 同 JS：filter(score > 0.08)
   ORDER BY f.sfinal DESC, f.created_at DESC, f.id DESC
   LIMIT v_limit;
END
$lf$;

COMMENT ON FUNCTION public.lf_search_text_v1(text, text[], integer) IS
  '失物招领文字检索 v1：移植自 assets/search.js@cc9e40d。返回公开字段+score/level/label/rank，detail/location/ai_* 不返回。';


-- ---------------------------------------------------------------------
-- §8 权限
--
-- 主函数：SECURITY DEFINER，执行身份 = 函数 owner = lost_items 表 owner
--   （生产实测该角色 rolsuper = false、rolbypassrls = true）。
--   为什么必须 DEFINER：detail 列一旦从 anon 撤掉 SELECT（见
--   ../2026-11-07_harden_public_columns.sql），INVOKER 函数就读不到 detail，
--   隐藏细节比对会静默失效。这是「用最小必要权限读一列」，不是
--   「拿管理员身份让调用成功」——没有放宽 SECURITY、没有授予超级用户，
--   也没有在函数里 SET ROLE。
--
-- helper：全部 SECURITY INVOKER（默认）+ 从 PUBLIC **以及 anon / authenticated /
--   service_role** 收回 EXECUTE（逐签名，见下）。它们只被主函数内部调用
--   （主函数以 owner 身份运行，owner 对自有函数天然有 EXECUTE），因此多一个
--   客户端可调的 rpc 端点都不需要 —— 少一组「拿 lf_dice_v1 当打分探针」的面。
--
-- ⚠️ 执行约定（实测踩到过）：**整份文件必须由同一个角色执行**。
--   helper 的 EXECUTE 只授给了 owner；如果主函数与 helper 的 owner 分叉
--   （例如事后单独 ALTER FUNCTION lf_search_text_v1 OWNER TO 别的角色），
--   anon 调用主函数会报 `permission denied for function lf_expand_v1`。
--   测试 tests/sql/permissions.test.mjs 与 privacy.test.mjs 都按「同 owner」建场。
--   真要换 owner，必须连 helper 一起改，或显式 GRANT EXECUTE 给新 owner。
--
--   执行完请核对一次（owner 不一致就别急着上线）：
--     SELECT (SELECT proowner::regrole::text FROM pg_proc
--              WHERE proname='lf_search_text_v1') AS fn_owner,
--            (SELECT relowner::regrole::text FROM pg_class
--              WHERE relname='lost_items')        AS tbl_owner;
--   两列不相同 → ALTER FUNCTION ... OWNER TO <tbl_owner>（9 个函数都要改）。
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.lf_search_text_v1(text, text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lf_search_text_v1(text, text[], integer)
  TO anon, authenticated, service_role;

-- helper：逐个精确签名撤销 **PUBLIC + 三个客户端角色** 的 EXECUTE。
--
-- ⚠️ 只写 `REVOKE ... FROM PUBLIC` 是不够的，这是一个真实的漏权路径：
--   PostgreSQL 允许
--       ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon;
--   一旦库上（或某个建库模板里）配过这条，本文件 CREATE FUNCTION 出来的每个
--   函数都会带一条 **直接授予 anon** 的 ACL 项；`REVOKE ... FROM PUBLIC`
--   只删 grantee=PUBLIC（oid 0）那一项，碰不到 anon 自己那条，
--   结果 anon 依然能 rpc 直打 lf_dice_v1 当打分探针。
--   所以这里对每个 helper 的准确签名显式列出四个受让方。
--   回归用例：tests/sql/permissions.test.mjs 的「默认权限」一节
--   （先 ALTER DEFAULT PRIVILEGES，再跑迁移，再跑第二遍）。
--
-- 撤销**不影响**函数执行身份：owner 对自有函数的 EXECUTE 是所有权自带的，
-- 不在 PUBLIC/角色 ACL 里；SECURITY DEFINER 的主函数以 owner 身份调 helper，
-- 因此主函数照常工作（permissions.test.mjs 用普通角色 app_owner 验证过）。
REVOKE ALL ON FUNCTION public.lf_expand_v1(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.lf_u16_units_v1(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.lf_bigrams_v1(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.lf_dice_v1(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.lf_haystack_v1(text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.lf_ai_tags_text_v1(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.lf_category_label_v1(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.lf_color_label_v1(text)
  FROM PUBLIC, anon, authenticated, service_role;
-- helper 不 grant 给任何客户端角色：只有 owner（SECURITY DEFINER 的执行身份）能调。

-- PostgREST 有 schema cache：新函数不刷新会被当成不存在（PGRST202）。
-- 生产执行时若网关未自动刷新，需补一次：
NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- §上线前提（2026-11-09 已按此顺序在新环境执行完毕，留作复现步骤）
--   1. 函数（§1…§7）→ 主函数授权（§8 前半）→ helper 撤权（§8 后半）→ NOTIFY；
--   2. 索引见 2026-11-07_lf_search_index.sql；
--   3. 列权限见 2026-11-07_harden_public_columns.sql；
--   4. 执行后核对（本次结果：owner 与 lost_items 表 owner 一致，主函数 acl 仅
--      anon/authenticated/service_role + owner，helper 仅 owner）：
--        SELECT proname, proowner::regrole, prosecdef, proacl FROM pg_proc
--         WHERE proname LIKE 'lf\_%';
--   5. 回滚（不影响表数据；列权限回滚见 2026-11-07_harden_public_columns.sql 文末）：
--        DROP FUNCTION public.lf_search_text_v1(text,text[],integer);
--        DROP FUNCTION public.lf_expand_v1(text);
--        DROP FUNCTION public.lf_u16_units_v1(text);
--        DROP FUNCTION public.lf_bigrams_v1(text);
--        DROP FUNCTION public.lf_dice_v1(text,text);
--        DROP FUNCTION public.lf_haystack_v1(text,text,text,text,jsonb);
--        DROP FUNCTION public.lf_ai_tags_text_v1(jsonb);
--        DROP FUNCTION public.lf_category_label_v1(text);
--        DROP FUNCTION public.lf_color_label_v1(text);
-- =====================================================================
