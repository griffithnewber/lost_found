# 文字检索迁移到共享 PostgreSQL 函数

> 分支：`feat/shared-text-search-v1`（已并入 main）
> 迁移文件：`db/migrations/2026-11-07_lf_search_text_v1.sql`、`..._lf_search_index.sql`、`..._harden_public_columns.sql`
> 测试：`tests/sql/*.test.mjs`（**87 条，全绿**）+ `tests/live/*`
> 算法版本常量：`lf-text-v1@cc9e40d`
> 状态：**2026-11-07 已在生产执行三份迁移并通过跨入口验收**（见文末「§11 上线记录」）。
> 唯一未完成项：`features.textSearch` 默认开启的那次前端发布（代码已就绪，等发布机执行）。

---

## 1. 为什么做这件事

main 上 `assets/search.js` / `assets/match.js` 已被删除（P0-T1/T2 把网页收敛成只读看板），
但"文字检索"这件事本身没消失——它搬进了阿寻的提示词里，靠"先捞 50 条、模型自己比对打分"
实现。结果是两份逻辑：一份删了，一份散在提示词里，没人能回归测试。

这次把它收口成一个**库里的函数**：网页（`LF.api.searchItems`）和阿寻（SQL 工具 / REST rpc）
调同一个实现，分数、排序、分级只有一处定义。

---

## 2. 迁移参考来源

从 `cc9e40de76bc6736d89e17e78ecd0cf877b5ade7` 取回 4 个文件，逐字节放进
`tests/fixtures/legacy-cc9e40d/`（作为测试基准，不参与线上运行）：

| 文件 | 用到的部分 |
|---|---|
| `assets/search.js` | `LF.search.text()`：同义词扩展、2-gram、Dice、标题/关键词加分、detail 私有信号 |
| `assets/match.js` | `LF.match.annotate()`：0.5 / 0.25 两级阈值与 label 文案 |
| `assets/ui.js` | `categoryMeta` / `toneMeta`：label 字典的取法（未知 key → 空串） |
| `assets/config.js` | 类别 / 主色调字典（历史版本） |

md5 与历史提交一致：`search.js = cc6a24b2c02ee694b80d9ac5f8a737bd`。

---

## 3. 环境核实结果（都是实测，不是假设）

### 3.1 `lost_items` 的真实结构

18 列，全部 `text` / `jsonb` / `timestamptz` / `bigint`，没有枚举类型、没有数组列：

| 列 | 类型 | 约束/默认 |
|---|---|---|
| `id` | `bigint` | PK，`GENERATED ALWAYS AS IDENTITY` |
| `title` | `text` | NOT NULL |
| `detail` | `text` | 可空（隐藏细节，**私有**） |
| `location` | `text` | 可空（具体存放位置，**私有**） |
| `notice` / `pub_time` / `image` / `ai_desc` | `text` | 可空 |
| `color_feature` / `ai_tags` | `jsonb` | 可空（`ai_tags` 是字符串数组） |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` |
| `status` | `text` | NOT NULL DEFAULT `'open'`（无 CHECK） |
| `post_type` | `text` | NOT NULL DEFAULT `'lost'`（无 CHECK） |
| `owner_id` / `pickup_location` / `category` / `color_tone` | `text` | 可空 |
| `claim_at` | `timestamptz` | 可空 |

**约束只有主键**；`status` / `post_type` / `category` / `color_tone` 的全集靠代码约定，
函数里不能假设枚举值合法。

索引原本只有 `lost_items_pkey`（+ `item_messages_pkey` / `idx_item_messages_item`）。
`created_at` 上没有索引 → 候选池查询要全表扫 + 排序。本轮补索引（§6）。

### 3.2 权限核实（生产实测，2026-11-07）

```
current_user = cloudbase_postgres_postgres_r18dwtka
  rolsuper = false, rolbypassrls = true, rolcreaterole = false
lost_items.relacl = {anon=arwd/…, authenticated=arwdDxtm/…, service_role=…}
public 的 nspacl  →  PUBLIC 只有 USAGE，没有 CREATE
```

两条结论：

1. **执行 SQL 工具的身份不是超级用户**，是库 owner（`rolbypassrls`）。这决定了
   `SECURITY DEFINER` 的"提权"上限就是"以表 owner 读表"，不是拿到管理员能力；
2. **`anon` 拿着表级 `SELECT`**——等于 18 列全开。这就是隐私缺口（§7），本轮修。

### 3.3 `workbuddy_cloudservice_db_exec_sql` 能不能跑自定义函数

| 验证 | 结果 |
|---|---|
| `mode=read` 绑定 `$1::text` / `$2::text[]` / `$3::int` | ✅ 三个位置参数都正确回填 |
| `SELECT * FROM` 集合返回函数并带参数 | ✅ `unnest($2::text[])` 与 `jsonb_to_recordset($1::jsonb)` 都验证过 |
| 工具的角色 | `mode=read` 只读、`mode=write` 改数据、`mode=migrate` 建表/DDL（走管理员角色、绕 RLS） |
| 执行身份 | 三种模式都不是 `anon`；函数由 `migrate` 创建 → owner 即该角色 |

⚠️ **`jsonb_to_recordset` 是内置函数，不能证明工具能调"新建的自定义函数"**——这一点已在
[§10.2](#102-真联调清单必须做不能只看-pglite) 单列成必须现场验证的项。

### 3.4 网页 SDK 能不能调数据库函数

网页用的是 `@tencent-ai/workbuddy-cloud-sdk`（`index.html` 从 jsDelivr 引入 `@dev`），
不是 supabase-js。读 bundle：

```
var j = "/.cloud", R = { auth: j+"/auth", database: j+"/database/rest", ... };
rpc(e, t = {}, …) { let url = new URL(`${this.url}/rpc/${e}`); … POST，body = 参数对象 }
```

`database` 模块自带 `rpc()`，**与 `supabase.rpc` 用法等价**，不需要适配层。
网关探测（对不存在的函数打一发只读 rpc）：

```
POST /.cloud/database/rest/rpc/lf_probe_not_exist {"p_query":"x"}
→ HTTP 404 {"code":"DATABASE_PGRST202","message":"Could not find the function public.lf_probe_not_exist(p_query) in the schema cache"}
```

路由是通的，差的只是函数本身；上线要 `NOTIFY pgrst, 'reload schema'`（迁移末尾已带）。

### 3.5 隔离测试环境

- WorkBuddy 这边只有**一个** applicationId（`wbapp_lmzAUiNMSssVs6mpvimKsP`），没有 staging 应用；
- 本机没有 `psql` / `pg_ctl` / `docker`；
- 仓库里也没有第二个 `wbapp_*`。

所以：**没有测试环境就不碰生产库**。语义层测试用 PGlite（PostgreSQL 16.4 编译到 WASM，
内存实例）跑真正的 PostgreSQL 语义，不是"用 JS 模拟 SQL"——包括 `CREATE ROLE` / `SET ROLE` /
`has_column_privilege` / `EXPLAIN`，所以权限与索引都是真跑的。

---

## 4. 接口

```sql
lf_search_text_v1(
  p_query    text,
  p_keywords text[]  DEFAULT '{}',
  p_limit    integer DEFAULT 20     -- 内部夹到 0..200
) RETURNS TABLE (
  id, title, category, color_tone, notice, status, post_type,
  pub_time, pickup_location,               -- 公开字段
  score             double precision,
  level             text,                  -- high / mid / low
  label             text,                  -- 「很可能就是它 · 65%」
  rank              integer,               -- 从 1 连续递增
  algorithm_version text                   -- 'lf-text-v1@cc9e40d'
)
STABLE SECURITY DEFINER SET search_path = pg_catalog
```

**返回列刻意不含** `detail` / `location` / `ai_desc` / `ai_tags`：前三者是私有信息，
`ai_tags` 是能反推隐藏特征的中间产物。它们在函数内部参与打分，但不进结果集。

辅助函数（`public`，`IMMUTABLE PARALLEL SAFE`，全部 `SET search_path = pg_catalog`）：

| 函数 | 作用 |
|---|---|
| `lf_expand_v1(text)` | 同义词扩展（键顺序与历史 JS 一致） |
| `lf_u16_units_v1(text)` | text → UTF-16 code unit 整数数组（**本轮新增**，emoji 等价的关键） |
| `lf_bigrams_v1(text)` | 清洗 + 2-gram 去重集合（gram = 两个 unit 的 4 位十六进制） |
| `lf_dice_v1(text,text)` | Dice 系数 |
| `lf_haystack_v1(title,color,category,notice,ai_tags)` | 打分用公开文本 |
| `lf_category_label_v1` / `lf_color_label_v1` | 字典快照（未知 → 空串） |
| `lf_ai_tags_text_v1(jsonb)` | `ai_tags` 数组 → 空格串 |

---

## 5. 语义逐条对照（JS → SQL）

| 历史 JS | SQL | 是否等价 |
|---|---|---|
| `qExpanded = expand(q) + ' ' + kw.join(' ')` | `lf_expand_v1(q) \|\| ' ' \|\| array_to_string(kw,' ')` | ✅ 连"关键词也进 qExpanded"这个易被忽略的点都保留 |
| `qLower = lower(q)`（不扩展，用于 detail） | `lower(p_query)` | ✅ |
| `haystack = [title, tone.label, cat.label, notice, aiTags]` | `lf_haystack_v1(...)` 同序拼空格 | ✅ `ai_desc` 不参与（历史只用于图片检索） |
| `filter(Boolean)` | 空串/null 跳过 | ✅ |
| 同义词扩展（12 组，插入序） | `lf_expand_v1` 12 个顺序 `IF` | ✅ 逐字照抄，含顺序 |
| 清洗 `\s ，。,.!?！？、；;：:"'（）()【】[]` | `[[:space:]]` + `translate(...)` + 显式补 U+00A0/1680/2000-200A/2028/2029/202F/205F/3000/FEFF | ✅ |
| `ngrams`：按 **UTF-16 code unit** 切、去重、长度<2 退化整串 | `lf_u16_units_v1` 展开成 unit 数组后两两配对，`DISTINCT` 去重 | ✅ **本轮修正**，见 §5.1 |
| `dice` 空集返回 0 | 同 | ✅ |
| `bonus = kw命中数*0.05 + title含query*0.15` | `count(*) * 0.05 + CASE position(...)` | ✅ 标题判定用 `position(query IN title) > 0`，**区分大小写**，与 `indexOf` 一致 |
| `score = base + min(bonus, 0.3)` | 同 | ✅ |
| `sec = dice(qLower, detail)`；`sec>0` 才 `+secKW*0.15`（封顶 1） | 同 | ✅ |
| `if (sec > 0.1 && base > 0.05) score = min(1, score + sec*0.9)` | 同 | ✅ 双门槛 + 0.9 权重 |
| `filter(score > 0.08)` | `WHERE sfinal > 0.08` | ✅ |
| 候选 = 最新 1000 条 → 再剔 `returned` | `cand` CTE `LIMIT 1000` → `live` 过滤 | ✅ **先截断后过滤** |
| `claimed` 保留、`found`/`lost` 都参与 | 同 | ✅ |
| 地点/时间加权 | 不存在 | ✅ 没有新增 |
| 分数不截断到 1 | 只在 sec 分支 `min(1, ...)` | ✅ 保留 >1 的分数 |
| 分级 0.5 / 0.25 + `Math.round(score*100)` | `>= 0.5` / `>= 0.25` + `floor(score*100 + 0.5)` | ✅（`round(double)` 是银行家舍入，所以用 floor+0.5 对齐 `Math.round`） |
| 同分靠 sort 稳定性保持入参序 | `ORDER BY score DESC, created_at DESC, id DESC` | ⚠️ 规格**新增的确定性规则**，见 §5.2 |

### 5.1 emoji / 星平面字符：已等价（本轮修正）

历史 JS 的 `t.length` / `t.slice(i, i+2)` 都按 **UTF-16 code unit** 计数。一个 emoji 是
2 个 unit，所以 JS 会把代理对切开：

```
'杯子😀'  JS：unit = [杯][子][高][低] → gram：杯子 | 子+高代理 | 高代理+低代理
          PG（码点）：[杯][子][😀]     → gram：杯子 | 子😀
```

上一版按码点切，`query='😀'` 打「杯子😀」只能拿 0.15（标题奖励），比历史 JS 的 0.3167 低——
**这是"没忠实移植"，不是"修了 JS 的 bug"**。本轮把 n-gram 改成 UTF-16 unit 语义：

- `lf_u16_units_v1`：`regexp_split_to_array(text,'')` 逐码点取 `ascii()`（UTF8 库返回码点），
  超出 BMP 的手工拆成 `0xD800 + ((cp-0x10000)>>10)` / `0xDC00 + ((cp-0x10000)&0x3FF)`；
- 不用 `convert_to(x,'UTF16')`：实测该 build 里没有 UTF16 编码（`invalid destination encoding name`），
  且转换会依赖服务端编码；
- gram 用「两个 unit 的 4 位十六进制拼接」表示：半截代理对在 `text` 里根本不是合法字符，
  十六进制对是双射，集合交并语义与 JS `Set<string>` 一致。

结果（同一语料、同一查询）：

| 用例 | 修正前 SQL | 现在 SQL | 历史 JS |
|---|---|---|---|
| `query=😀` × LF-111「杯子😀」 | 0.1500 | **0.3167** | 0.3167 |
| `query=😀` × LF-112「杯子😀x」 | 0.3038 | **0.3038** | 0.3038 |
| `query=杯子😀` × LF-111 | 0.5786 | **0.5786** | 0.5786 |

另外把 `lf_u16_units_v1` 的长度与 JS `String.length` 逐串对齐（含 ZWJ 组合 emoji `👨‍👩‍👧`），
gram 数量与 JS `Set` 大小逐串对齐——不是只对一个 emoji 打补丁。

### 5.2 同分排序：规格新增的确定性规则（不是历史行为）

历史 JS 依赖 `Array.prototype.sort` 的稳定性，同分时保持入参顺序；入参来自 `listItems()`
（`created_at DESC`），所以**同一秒创建的两条记录，历史顺序其实取决于数据库返回顺序**，
不确定也不可复现。

SQL 显式 `ORDER BY score DESC, created_at DESC, id DESC`。为了让"对照"仍然成立，
`tests/lib/corpus.mjs legacyCandidates()` 在喂给历史实现之前就按同一顺序排好候选，
并且测试里断言两侧同分顺序都是 107 → 106。

> 规格里必须写清楚：这是**新增规则**。它会让极少数同分同秒记录的顺序与旧前端不同，
> 换来的是可复现性。

### 5.3 字典快照

字典固定成 `cc9e40d` 版本（你的决定：v1 不动，以后单独升级），于是现行新增的枚举在 v1 里
**没有 label**：

| 现行值 | v1 行为 |
|---|---|
| `category = wallet` / `glasses` | label 为空 → 不追加到 haystack（等于少一个信号） |
| `color_tone = brown` / `purple` / `clear` | 同上 |

与历史 JS 行为一致（`categoryMeta` 未知 key 返回 `{label:''}`，被 `filter(Boolean)` 丢掉）。
要覆盖新枚举必须发 `v2`，改 v1 会让历史分数不可复现。

---

## 6. 索引评估（`2026-11-07_lf_search_index.sql`）

函数候选池的查询形状是 `ORDER BY created_at DESC, id DESC LIMIT 1000`：

```sql
CREATE INDEX IF NOT EXISTS idx_lost_items_created_id_desc
  ON public.lost_items (created_at DESC, id DESC);
```

为什么是两列而不是只 `created_at`：只建 `created_at` 时，同秒记录仍需在内存里按 id 二次排序，
而且与 §5.2 的 tie-break 对不上；两列同方向同顺序时可以直接走索引取前 1000 行。

隔离库（PGlite，3000 行 + `ANALYZE`）实测：

```
[索引] 计划节点：Limit → Index Only Scan          （SET enable_seqscan=off）
[索引] 未强制时的计划节点：Limit → Index Only Scan （自然计划也是它）
```

即：**没有 Sort 节点**，取前 1000 行就停。另有一条用例证明加索引前后候选 id 序列完全一致
（索引不改语义），以及迁移可重复执行（`IF NOT EXISTS`）。

生产执行注意：小表直接建；表已很大时改手工 `CREATE INDEX CONCURRENTLY`（不能放进事务块），
建完 `ANALYZE public.lost_items;`。

---

## 7. 隐私缺口：上线阻断项，本轮给出完整方案

### 7.1 缺口事实

`anon` 有 `lost_items` 的表级 `SELECT`（`relacl = anon=arwd`），而网页的公开密钥发给每个访客。
于是：**任何人 `GET /rest/lost_items?select=*` 就能把每条记录的 `detail` 整列读走**——
而 `detail` 正是核验依据（学生证上的名字、划痕位置）。同类的还有 `location`（具体存放位置）、
`ai_desc`（AI 对照片的描述，能反推出图案/配件）、`ai_tags`。

网页自己也在帮着扩散：`api.js` 的 `ITEM_COLS` 里带着 `detail`，还把整条记录写进
`localStorage`。

### 7.2 做法（`2026-11-07_harden_public_columns.sql`）

1. `REVOKE SELECT ON lost_items FROM anon, authenticated;`（表级 SELECT 在时，列级限制无效）
2. `GRANT SELECT (14 个公开列) ...`：`id,title,image,color_feature,notice,category,color_tone,
   status,post_type,owner_id,pickup_location,claim_at,pub_time,created_at`
3. **不授权**：`detail` / `location` / `ai_desc` / `ai_tags`
4. `INSERT / UPDATE / DELETE` 保持原样——登记表单要写 `detail` 和 `location`，**能写不能读**
5. `service_role` 不动

### 7.3 受影响路径（逐条核过代码，不是"应该没事"）

| 路径 | 会不会坏 | 处理 |
|---|---|---|
| 广场 / 我的发布 / 留言 | 不坏 | 只读 `id,title,image,notice,category,color_tone,status,post_type,pub_time,pickup_location,owner_id`，全在授权内 |
| `listItems()` | 会坏（原来带 `detail`） | 改成 `PUBLIC_COLS` 常量，与迁移的授权列表逐字一致 |
| `findItemById()`（按编号/直达链接） | 会坏（`select('*')`） | 改显式列 |
| `bindItemOwner()` | 会坏（`select('*')`） | 改显式列（含 `owner_id`） |
| `createItem()` | 会坏（`.select()` 默认返回全部列） | 改 `.select(PUBLIC_COLS)`；测试验证 `RETURNING *` 确实被拒（实测 401 + `DATABASE_42501`） |
| 旧缓存（`localStorage`） | 会留存量隐私数据 | 缓存 key `v1 → v2`，**直接丢弃旧 key 不迁移**；`loadCache/saveCache` 都过 `stripHidden` |
| `rowToItem()` | — | 不再映射 `detail/location/aiDesc/aiTags` |
| 网页核验 `assets/ai.js` | **不会坏：本来就是死代码** | `makeQuestion/judgeAnswer/localJudge/secretGrams/ngrams/dice` 全仓库无调用方（核验已迁到阿寻）。已删除，只留说明 |
| 阿寻核验 | 不坏 | 走 SQL 工具，身份是库 owner（`rolbypassrls`），不受列权限影响；`SET ROLE anon` 的测试证明"anon 读不到、函数仍能用" |
| 通道二（REST + 公开密钥）读 `detail` | **会坏，而且应该坏** | 提示词里改成"核验只能走通道一"；`select=detail` → 401/403（实测 401）要认成"权限生效"，不是"没有记录" |

### 7.4 验证（`tests/sql/privacy.test.mjs`，6 条）

- 收紧**前**先证明缺口真实存在（anon 能读 `detail`/`location`）；
- 收紧后：4 个隐藏列 `has_column_privilege = false`，表级 SELECT 已收回；
- anon 实读：公开列通过、`select detail` / `select location` / `select *` 全部 `permission denied`；
- 写入不坏：anon 仍能写 `detail`/`location` 并 `RETURNING id,title`；`RETURNING *` 被拒；
- **功能不坏**：anon 调 `lf_search_text_v1('写有名字的证件卡')` 仍拿到 `base 0.1176 + sec 0.1111*0.9 = 0.2176`
  ——detail 在函数内部生效、但不出现在返回列；
- owner（阿寻）照旧能按编号读 `detail`。

---

## 8. 权限审查（函数面）

| 检查 | 结果 |
|---|---|
| 只有 `lf_search_text_v1` 是 `SECURITY DEFINER` | ✅ 其余 8 个 helper 全 `INVOKER` |
| 为什么 DEFINER | `detail` 撤了 anon 的 SELECT 后，INVOKER 函数读不到它，隐藏细节加分**会静默失效**。DEFINER 的执行身份就是表 owner，权限上限＝"以表 owner 读表"，没有 `SET ROLE`、没有授予超级用户 |
| `search_path` | 9 个函数全部 `SET search_path = pg_catalog`（不含 `public`、不含 `pg_temp`），内部对象全部 `public.` 限定 |
| anon / authenticated / service_role 的 EXECUTE | 只对主函数有，对 8 个 helper **一律没有** |
| PUBLIC 的 EXECUTE | 全部 `REVOKE`，`proacl` 里没有空 grantee |
| 函数体 | 无 `SET ROLE`、无 `session_user` / `current_setting('role')` |
| 执行身份是否依赖管理员 | 测试把 owner 换成普通角色 `app_owner` 后照样跑通（`permissions.test.mjs`） |

⚠️ **迁移执行约定（实测踩到过）**：整份文件必须由**同一个角色**执行。helper 的 EXECUTE 只授给
owner，一旦主函数与 helper 的 owner 分叉，anon 调主函数会报
`permission denied for function lf_expand_v1`。这条已写进迁移文件 §8 的注释。

---

## 9. 测试结果

```
$ cd tests && npm install && node --test
# tests 87   # pass 87   # fail 0
```

13 个 suite：`与历史 JS 对照`（含**输入契约：只 trim**）、`emoji 等价`、`字典快照`、
`函数权限面`（含 `ALTER DEFAULT PRIVILEGES` 回归）、`匿名隐私列收紧`、`候选池索引`、
`LF.api.searchItems`（成功/失败路径 + 输入契约）、`文字检索入口`（渲染 + index.html 接线）。

### 9.1 顺序 / 分数 / 分级完全一致（16 组查询）

| 查询 | 结果（两侧逐条相同） |
|---|---|
| `耳机` | #113 0.8457 high / #105 0.7775 high / #102 0.7382 high |
| `黑色耳机` + [耳机,黑色] | #113 0.9077 / #102 0.8368 / #105 0.8368 / #115 0.1895 |
| `证件卡` | #117 0.3100 mid / #103 0.3038 mid |
| `写有名字的证件卡` | #103 0.2290 low / #117 0.1333 low |
| `钥匙`（中文括号） | #108 1.0000 high |
| `iphone`（大小写） | #109 0.2632 mid |
| `书包` + [背包] | #114 0.6375 high |
| `黑色水杯`（sec=0 对照） | #115 0.7429 / #111 0.6400 / #112 0.6154 / #113 0.1364 / #102 0.1224 / #105 0.1224 |
| `张三丰`（防猜） | 两侧都为空 |
| `雨伞`（同分两条） | #116 1.0000 / #107 0.7278 / #106 0.7278 |
| `aa` | #101 1.1500 high |
| `bb` + [bb] | #118 1.2000 high（分数 > 1 未被截断） |
| `😀` | #110 1.1500 / #111 0.3167 / #112 0.3038 |
| `杯子😀` | #111 0.5786 / #112 0.5500 / #110 0.5000 / #115 0.0833 |
| `杯`（单字退化） | #115/#111/#112 各 0.1500 |
| 无命中 | 两侧都为空 |

### 9.2 关键用例

| 用例 | JS | SQL | 结论 |
|---|---|---|---|
| `title=aa`、`query=aa` | 1.15 | **1.15**（label「很可能就是它 · 115%」） | ✅ |
| 重复关键词 2 次（+标题奖励） | 0.9518 | 0.9518 | ✅ base 0.7018 + 0.25 |
| 重复关键词 4 次 | 1.0368 | 1.0368 | ✅ bonus 从 0.35 封顶到 0.3 |
| 隐藏细节门槛 | 0.2290 | 0.2290 | ✅ base 0.1290 / sec 0.1111（>0.1）→ +0.1 |
| sec=0（LF-115） | 0.7429 | 0.7429 | ✅ |
| base 不达标（LF-116） | 不出现 | 不出现 | ✅ |
| returned / claimed | 剔除 / 保留 | 同 | ✅ |
| 同分同秒 | 107 → 106 | 107 → 106 | ✅ 两侧同序 |
| 候选池 1000 条 | 命中 0 | 命中 0 | ✅ 不截断时 JS 能中 5 条、最高 1.15 |
| emoji 相邻 | 0.3167 | 0.3167 | ✅ **本轮修掉的反例** |
| 返回列 | — | 14 列，无 `detail/location/ai_desc/ai_tags` | ✅ 逐字段断言 + 全文扫描无泄漏 |

---

## 10. 还差什么才能上线

### 10.0 真联调结果（2026-11-07，已在本轮跑完）

**测试应用**：`wbapp_mnw…`（完整 id 与密钥只存本地 `.env.test`）（会话内新建的独立应用，域名 `<测试应用域名>`），
与生产应用 `wbapp_lmzAUiNMSssVs6mpvimKsP` **不同库、不同域名、不同密钥**。
建在独立目录 `<本地独立目录>`（不是仓库目录）——发布是按目录找应用的，同目录绑两个应用会让「发布」落到不确定的目标上。
**未发布、无外网页面**；密钥只写在仓库根 `.env.test`（已 gitignore），全程没有出现在对话里。

**测试库现状**：`lost_items` 按生产结构重建（18 列、同类型/默认值/主键），RLS 四策略照搬，
表级 SELECT 收回后按 14 列授权；三份迁移逐条执行（工具限制：一次一条语句，共 22 条 DDL，
跳过 9 条纯注释性质的 `COMMENT ON`，不影响语义与权限）。
实测确认：9 个函数 owner = `cloudbase_postgres_postgres_ls2wz7j4`（= 表 owner，非超级用户）；
helper 的 ACL 只有 owner，主函数 `anon/authenticated/service_role` 均可执行。

**结果：`node tests/live/rpc_smoke.mjs` → 51 项全绿**（6 组查询 × 6 条断言 + 4 条错误路径 + 3 条隐私）
与 `node tests/live/compare.mjs` → 网页侧与 SQL 工具侧**逐项完全一致**（分数最大误差 0.00e+0）。

| 查询 | 网页（SDK + `LF.api.searchItems`） | SQL 工具（管理员身份直查） |
|---|---|---|
| 黑色耳机 | #25 0.736842 high r1 · #28 0.736842 high r2 | 同 |
| 证件卡 + 学生证 | #26 0.475862 mid r1 · #31 0.435714 mid r2 | 同 |
| aa | #29 1.150000 high r1 | 同 |
| 😀 | #30 0.267647 mid r1 | 同 |
| 雨伞 + 遮阳伞 | #32 0.727778 high r1 | 同 |
| 不存在的词 | `[]` | `[]` |

每组还断言了：结果非空且含指定编号（空数组蒙不过去）、`rank` 连续 1..n、编号与标题一一对应、
返回列不含 `detail/location/ai_desc/ai_tags`、以及与**历史 JS 现算的期望值**逐条相同。

**三条实测发现（与之前的假设不同，已据此改代码/文档）**：

1. 函数缺失时网关的错误码是 **`DATABASE_PGRST202`**（带命名空间前缀），不是裸 `PGRST202`。
   `api.js` 因此用 `/PGRST202/` 做**包含**匹配，而不是全等 —— 全等会漏判成 `rpc_failed`。
2. 列权限被拒时 HTTP 状态是 **401 + `DATABASE_42501`**（不是 403）。原因：`anon` 在 PostgREST 里是
   no-privilege 角色，权限错误对它返回 401。判定逻辑必须用「401/403 + 响应体 `permission denied`」。
3. 密钥错误时错误体是 `{"error":"invalid_client",...}`，没有 `message` 字段 ——
   所以 `searchItems` 的失败分支必须能从裸对象里取文本，否则界面会显示 `[object Object]`（已修）。

### 10.1 隔离测试库：怎么来、怎么删

**A. 让智能体建（本轮用的就是这条）**：`workbuddy_cloud_service` 工具支持
`applicationMode: "create"` + `appName` + `domainPrefix`，会新建一个独立应用并开通云服务；
确认弹窗由 WorkBuddy UI 弹出（占用账号的应用配额，费用按平台的云服务额度/用量计，
本轮只做了数据库读写，量极小；**未发布、未升级任何付费项**）。
不想保留时在应用管理里删掉即可，生产库完全不受影响。

**B. 手工路径（现实里没有「新建应用」按钮）**

产品里的「应用管理」只能**查看 / 发布 / 下线 / 删除**，没有「新建独立应用」的入口 ——
独立应用只能由云服务开通（A）或发布站点产生。所以真正可手工做的是这两件事：

1. **复用一个已存在但没在用的应用**：把它的 `endpoint` + `publishableKey` 写进仓库根 `.env.test`
   （已 gitignore），再告诉我 `applicationId`，我用 `mode=migrate` 在它库里建表/建函数。
2. **删掉这个测试应用**：应用管理里删除即可；它没有发布过，删掉不影响任何线上页面，
   生产应用 `wbapp_lmzAUiNMSssVs6mpvimKsP` 完全不受影响。

不管走 A 还是 B，密钥都只落 `.env.test`，不进聊天、不进仓库。

### 10.1b 两端输入统一（v1 输入契约，2026-11-07 定稿）

**契约**：文字查询**只 `trim`、不改写原话**（不转小写、不拆词、不扩同义词）；
`p_keywords` **固定 `[]`**，同义词只由函数内置字典 `lf_expand_v1` 处理。
函数签名保留 `p_keywords`，供离线对照测试和以后版本使用。

| 端 | 实现 | 证据 |
|---|---|---|
| 网页 | `api.searchItems(query, limit)`：`p_query = String(query).trim()`、`p_keywords: []`（旧的三参数写法也塞不进关键词） | `tests/unit/api_search.test.mjs` 2 条输入契约用例 |
| 智能体 | 提示词：`p_query` 填原话只 trim、`p_keywords` 固定 `[]`、`p_limit=3` | 提示词「文字搜索」节 + B1 节 |
| 函数 | 入口再 `btrim` 一次（含制表/换行/全角空格）——`btrim` 默认只去空格，这里必须显式列出 | parity 用例：`aa` 与 `\t  aa  \n` 逐项相同且都保留 1.15 |
| 验收 | 同一句原始输入，网页前 3 条 = 阿寻 3 条（编号/分数/rank/level/label） | 7 组查询逐项相同（含 `  雨伞  ` 与 `雨伞` 同结果、零结果组） |

### 10.2 真联调清单（四项全部已实测通过）

| # | 项 | 手段 | 结果 |
|---|---|---|---|
| 1 | SQL 工具调用 `lf_search_text_v1`（自定义函数，不是内置函数） | `mode=read` + `SELECT ... FROM lf_search_text_v1($1,$2,$3)` 绑定参数 | ✅ 见 §10.0 表右列 |
| 2 | 网页 SDK 的 rpc 调同一个函数 | `tests/live/rpc_smoke.mjs`：CDN 上的 SDK + 真实 `api.js`，跑在 node:vm 里，用 publishable key 走 anon 身份 | ✅ 51 项 |
| 3 | 相同输入 → 相同编号/分数/顺序/rank/level/label | `tests/live/compare.mjs` 比对两份 JSON | ✅ 完全一致 |
| 4 | 无权限 / 函数缺失 / 网络失败 ≠ 没有匹配 | 404 `DATABASE_PGRST202`、错误密钥 `invalid_client`、端点不可达 `fetch failed`、`select=detail` 401 `DATABASE_42501` | ✅ 全部判成 `ok:false` |

（2026-11-07 复跑：**59 项全绿**，用例已按 `p_keywords=[]` 重写，另加「首尾空白不影响结果」一组。）

`rpc_smoke.mjs` 的护栏：endpoint 命中生产域名时直接拒绝运行（除非 `--allow-prod-readonly`，那种模式只读不写）。
`--keep` 保留种子数据，便于和 SQL 工具对照；默认跑完即删（`owner_id=LFTEST_SEED`）。
SDK 抓不到时（例如 Node 连不上 jsdelivr）会退回用 `curl` 抓同一个 URL，缓存到 `tests/live/.cache/`。

### 10.3 浏览器预览（连测试库，不碰生产）

`tests/live/make_preview.mjs` 生成 `.preview-test/`（gitignore）——index.html + assets 的**副本**，
只改副本里的 endpoint / 密钥为 `.env.test` 的测试应用，并注入仅供预览的 `?broken=1` 故障开关。
生成时三重护栏：`.env.test` 指向生产域名/生产密钥直接拒绝；产物全目录扫描，
出现生产域名或生产密钥就删除产物并报错；写 `preview-manifest.json` 记录所连 applicationId。

**已在真实 Chromium 里点验（agent-browser，2026-11-07）**：

| 场景 | 入口 | 结果 |
|---|---|---|
| 开关关闭 | `/` | 检索卡片 hidden、不挂载，横幅照旧「不能搜索」 |
| 搜到记录 | `/?textsearch=1` 搜「黑色耳机」 | LF-33 / LF-36 · 0.7368 · rank 1/2，与 SQL 工具、阿寻完全一致（截图 `tests/live/out/preview-search-ok.png`） |
| 零结果 | 搜「这个词一定不存在xyz」 | 「检索成功，没有匹配的记录」 |
| 请求失败 | `/?textsearch=1&broken=1`（注入错误密钥） | 「检索失败：…invalid_client…（这是失败，不是没有匹配）」，红色 ts-error（截图 `preview-search-fail.png`） |
| 回归 | 广场 7 件、信箱（未登录提示）、编号绑定（弹登录）、📷 补照片入口 ×7 | 均正常，未受检索改动影响 |

### 10.4 上线顺序（顺序错了会白屏）

1. 前端先上（`api.js` 的新 `PUBLIC_COLS` + `v2` 缓存 + `ai.js` 清理）——否则旧版 `select('*')` 会 401/403（列权限已收）；
2. 执行 `lf_search_text_v1`（+ `NOTIFY pgrst, 'reload schema'`）；
3. 执行索引；
4. 执行列权限收紧；
5. 验证：广场 / 我的发布 / 按编号绑定 / 阿寻检索 / 阿寻核验 / REST 401·403 语义（实测是 401）；
6. 观察 24h：日志筛 `permission denied for table lost_items`，应只剩"故意探测"的那几条。

**执行后自检（必做）**：函数的 owner 必须与 `lost_items` 的表 owner 一致，否则 anon 调函数会
`permission denied for function lf_expand_v1` 或函数读不到表：

```sql
SELECT (SELECT proowner::regrole::text FROM pg_proc WHERE proname='lf_search_text_v1') AS fn_owner,
       (SELECT relowner::regrole::text FROM pg_class WHERE relname='lost_items')        AS tbl_owner;
```

两列不同 → `ALTER FUNCTION ... OWNER TO <tbl_owner>`（9 个函数都改）。`mode=migrate` 用的是
管理员角色，理论上与建表角色相同，但这属于"假设"，上线前必须实测一次。

**回滚**：列权限 `GRANT SELECT ON lost_items TO anon, authenticated;`；函数与索引直接 `DROP`。
都不动表数据。

---

## 11. 还需要你决定 / 操作

| # | 事项 | 状态 |
|---|---|---|
| 1 | 字典是否覆盖 `wallet/glasses/brown/purple/clear` | 你已定：**v1 保持历史版本**，以后走 v2 |
| 2 | `(created_at DESC, id DESC)` 索引 | 你已定：写入迁移文件、隔离库验证、**暂不生产执行**（§6 已验证：Index Only Scan、无 Sort） |
| 3 | emoji 差异 | 你已定：**必须等价**；已改 UTF-16 unit 切分并加反例测试（§5.1） |
| 4 | 同分排序 | 你已定：保留显式规则，**在规格里标为新增**，JS 对照同序（§5.2） |
| 5 | 权限审查 | 已补 `permissions.test.mjs`（8 条）+ **默认权限回归**（`ALTER DEFAULT PRIVILEGES` 场景，含重复执行），未使用管理员身份兜底（§8） |
| 6 | 隐私缺口 | 已作为**阻断项**处理：迁移 + api.js/ai.js/缓存/阿寻通道面全部改完并测过（§7） |
| 7 | 专家 zip | 已重打（≠部署），包内 `plugin.json` 版本 **1.15.1**，未安装未发布 |
| 8 | 测试库 | ✅ 已建（`wbapp_mnw…`（完整 id 与密钥只存本地 `.env.test`），独立应用、未发布），四项真联调全部跑通（§10.0） |
| 10 | 网页入口 | ✅ 已补 `assets/textsearch.js`（开关控制，默认关），文案与测试同步 |
| 11 | 线上数据 | 生产库本轮仍**只读**：未建函数、未加索引、未动权限 |
| 9 | commit | 输入统一、提示词修正、浏览器验收通过后已在开发分支 **commit 一次**（未 push、未合 main） |

---

## 12. 仍然存在、但本轮不动的风险

1. `status` / `post_type` / `category` / `color_tone` 没有 CHECK：字典快照 + 拼写错误会静默退化成"没有 label"；
2. `item_messages` 对 `anon` 是 `ar`（可读可写），留言里的联系方式靠产品约定"只给记录主人"——
   权限层面没拦；本轮未动（它不属于 detail 这一类核验依据，但值得单列）；
3. `anonymous` 可 `UPDATE/DELETE` 任意 `lost_items` 行（`lost_items_update_all` USING `true`）：
   任何访客能改别人的记录，甚至把 `status` 改成 `returned`。这是比 detail 更宽的口子，
   修它需要引入归属校验（`owner_id = auth.uid()` 之类），**不适合塞进这次迁移**，必须单独立项。

---

## 11. 上线记录（2026-11-07 生产执行）

应用：`wbapp_lmzAUiNMSssVs6mpvimKsP`（`lost-found-75068`）。执行前基线见
`tests/live/out/prod-baseline-2026-11-07.md`（当时 `lf_*` 函数 0 个、无 `created_at` 索引、
`lost_items` 18 列对 anon 全可读）。

### 11.1 三份迁移的实际结果

| 迁移 | 语句数 | 结果 |
|---|---|---|
| `2026-11-07_lf_search_text_v1.sql` | 29 | 全部成功。9 个函数（8 helper + 主函数），主函数 `SECURITY DEFINER` / `STABLE` / `search_path=pg_catalog`，owner = `lost_items` 表 owner |
| （同上）授权 | 11 | 主函数 `REVOKE PUBLIC` → `GRANT anon/authenticated/service_role`；8 个 helper 逐签名 `REVOKE PUBLIC, anon, authenticated, service_role`；`NOTIFY pgrst,'reload schema'` 已发 |
| `2026-11-07_lf_search_index.sql` | 2 | `idx_lost_items_created_id_desc (created_at DESC, id DESC)` 已建 + 注释；另补一次 `ANALYZE` |
| `2026-11-07_harden_public_columns.sql` | 2 | 收回表级 SELECT，按 14 列授权。`detail/location/ai_desc/ai_tags` 对 anon/authenticated 已不可读 |

注：网关一次只接受**单条**语句（多语句报 `DATABASE_42601`），所以按语句逐条执行，
函数体作为完整语句提交，未按分号拆函数体。

### 11.2 执行后实测

- 权限矩阵：`anon` 对 8 个 helper `EXECUTE=false`，对主函数 `true`；表级 `SELECT=false`，
  `INSERT/UPDATE/DELETE` 仍 `true`（写-only 列照旧可写）。
- 匿名实跑：`select id,detail` / `id,location` / `id,ai_desc` / `*` 全部 `DATABASE_42501`；
  14 列公开字段正常返回。
- 匿名 rpc：`lf_dice_v1` → 42501；`lf_expand_v1` / `lf_bigrams_v1` / `lf_haystack_v1` → PGRST202；
  `lf_search_text_v1` → 200 且返回 2 行。网关 schema 缓存已刷新。
- 跨入口一致（同一句「黑色耳机」，`p_keywords=[]`）：
  - 网页（真浏览器 + `?textsearch=1`）：LF-18 / 65% / 很可能就是它；LF-30 / 21% / 参考项
  - 阿寻 1.15.1（真对话）：id 18 → 0.6452 high，id 30 → 0.2086 low，顺序相同
- 核验：阿寻按编号取到 `detail`（划痕 + 贴纸），回复只给泛称问题，未泄露原文。
- 业务流程（生产、专用测试记录 LF-31 + 两个验收账号）：绑定 → 照片持久化 + 模糊展示 →
  交叉抢绑被拒 → 留言 → 对方信箱「进行中 / 🆕 新回复」→ 回复 → 确认认领 → `status=returned`
  且两侧广场均下架。

### 11.3 回退

- 函数：按 §8 文末的 9 条 `DROP FUNCTION` 逆序删除；不影响表数据。
- 索引：`DROP INDEX IF EXISTS public.idx_lost_items_created_id_desc;`
- 列权限：`GRANT SELECT ON TABLE public.lost_items TO anon, authenticated;`
  —— 该语句会一次性恢复 18 列（含 detail/location），**只能在明确决定后手工执行**，
  不得写成自动回退步骤。
- 前端：`assets/config.js` 把 `features.textSearch` 改回 `false` 并重发；
  或对单个访问者用 `?textsearch=0`。
