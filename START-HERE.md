# 从这里开始（队友第一份要读的文件）

这个仓库里有**两个东西**，共用一套云数据库：

- **智能体**「寻物官 · 阿寻」—— 你对着它说话，它帮你登记、找东西、核验身份。比赛提交的主体。
- **网页版** —— 广场、信箱、以后的地图，让别人"看得见"数据。

两边改法完全不同：智能体改的是**一段文字**，网页改的是 **JavaScript**。这份文档告诉你每件事该改哪儿、怎么验、花谁的积分。

---

## 0. 十分钟上手

```bash
git clone https://github.com/griffithnewber/lost_found.git
cd lost_found
git config --global http.proxy http://127.0.0.1:7890   # 如果你的网络需要代理
```

**看网页**：直接开线上链接（必须带 sharecode，裸域名会 403）

```
https://lost-found-75068.app.workbuddy.host/?sharecode=YEX2LGOS5J
```

本地预览也行，不需要 npm、不需要构建：

```bash
python3 -m http.server 8000    # 然后开 http://localhost:8000
```

**看智能体**：装到自己的 WorkBuddy 里，见下一节。

---

## 1. 装智能体（每人一次）

```bash
bash expert/build.sh          # 生成 docs/lost-found-assistant.zip
```

把 zip 拖进 WorkBuddy 对话框，说「导入这个专家包」。重启后在左侧「专家」里看到「寻物官 · 阿寻」就成了。

> 只把目录拷到 `~/.workbuddy/plugins/marketplaces/my-experts/plugins/` 还不够，还要在 `marketplace.json` 里登记，否则专家中心不显示。第一次装直接用 zip 最省事。

装完先发一句「有没有人捡到一把蓝色雨伞」验证：它应该明确说没查到，**不能**编一个编号出来。这条过了说明版本是对的。

详细版（含版本号、重装命令、常见坑）：**[`expert/README.md`](expert/README.md)**

---

## 2. 改智能体

**只改一个文件**：`expert/lost-found-assistant/agents/lost-found-assistant.md`

它全是中文句子，不涉及代码。改完必须：

```bash
bash expert/build.sh                    # 1. 重新打包
# 2. 重装到自己 WorkBuddy（或直接重新导入 zip）
# 3. 按 expert/TESTING.md 跑用例
```

三条必跑：P1（登记不能一次倒完问题）、N2（说黑色耳机不能答成粉色学生证）、N3（没查到不能编造）。

改完别忘了升 `plugin.json` 里的 `version`，不然分不清谁装的是新版。

**完整规则**：**[`expert/README.md`](expert/README.md)** ｜ **测试用例**：**[`expert/TESTING.md`](expert/TESTING.md)**

---

## 3. 改网页

不用构建，改完刷新就生效（记住按 `⌘⇧R` 强制刷新，浏览器缓存很顽固）。

### 文件都是干什么的

| 文件 | 行数 | 管什么 | 谁 |
|---|---|---|---|
| `index.html` | 128 | 页面骨架、模块加载顺序 | — |
| `assets/config.js` | 65 | 云库地址、模型名、类别/颜色字典、限流阈值 | A |
| `assets/api.js` | 289 | 所有云库读写都在这，页面别处不许直接 fetch | A |
| `assets/auth.js` | 334 | 注册登录、登录闸门 | A |
| `assets/ai.js` | 332 | 调模型：看图、出核验题、判答 | A |
| `assets/contact.js` | 273 | 留言线程 | A |
| `assets/square.js` | 121 | 广场列表 | A |
| `assets/mailbox.js` | 117 | 信箱 | A |
| `assets/search.js` | 146 | 文字/图像检索算分 | C |
| `assets/match.js` | 34 | 匹配打分 | C |
| `assets/stats.js` | 61 | 统计 | C |
| `assets/ui.js` | 408 | 所有渲染 | B |
| `assets/app.js` | 946 | 入口、tab 切换、主流程 | B |
| `assets/*.css` | — | 样式，按模块拆开 | B |

加载顺序在 `index.html` 底部：`config → api → ai → ui → search → match → stats → app → contact → square → auth → mailbox`。**新模块要加在这串里，早了拿不到 `LF`，晚了没人调。**

### 加一个功能的四步（以「寄存点」为例）

1. **先加表**。云库加 `locations`（`id / name / address / lat / lng / hours / contact / status`），`lost_items` 加一个 `pickup_location_id`。没有表就先写页面，最后一定返工。
2. **api.js 加方法**。`LF.api.listLocations()`、`LF.api.itemsAtLocation(id)`。所有 SQL 都收在这个文件里，别散到页面里。
3. **ui.js 渲染 + 新模块打点**。列表放 tab 里，地图单独一个 `assets/map.js`，在 `index.html` 里引一次。
4. **最后才动智能体**。提示词里加一段「要不要放到就近寄存点」，并把新字段写进 `expert/README.md` 的字段对照表。

**地图只能用腾讯/高德/百度/天地图**，Google、Mapbox、Leaflet + OSM 都不合规。腾讯有代理模式，本地开发不用申请 key；但**发布到公网必须自己申请 key 并配域名白名单**，否则底图一片灰。坐标系用 GCJ-02。

---

## 4. 协作约定

- **分支**：`agent/xxx` 改智能体，`web/xxx` 改网页，`docs/xxx` 改文档。别直接推 main。
- **PR**：至少一个人看过再合。
- **智能体是单文件**，两个人同时改必冲突 —— 动笔前在群里说一句改哪段。
- **测试数据**：写库测试一律在公开说明前加「【测试】」，测完 `DELETE FROM lost_items WHERE notice LIKE '【测试】%';`。`16`、`18` 两条是演示固定靶子，别动。
- **积分归属**：队友在自己电脑上装阿寻、对话测试，扣队友自己的；网页里的「AI 核验」走你账号下的云应用通道，扣你的 —— 这块少点几下。
- **版本号**：改一次升一位，现场演示前三个人对一下。

### 重要：push 不等于上线

队友 push 只是把代码交进仓库，**评委看到的那一份不会自动变**。两个人对外的东西都只在仓库所有者（队长）的机器上更新：

| 队友改了什么 | 他自己能看到效果吗 | 谁负责让"外面"看到 |
|---|---|---|
| 只改文档 | GitHub 上立刻可见 | 不用管 |
| 网页 + push | 本地刷新能看到，线上还是旧的 | **队长重新发布一次** |
| 智能体 + push | 他重装一次就能自测 | **队长重装 + 重启**，比赛链接才会变 |
| 只在本机试、没 push | 只有他自己看得到 | 不用管，也不影响别人 |

所以约定是「**合并即发布，发布只由队长做**」。队友不要各自去点发布，也不要反复催——把改动攒成一个 PR 一次交过来，队长那边一趟做完：`git pull` → 发布网页 → 重装专家 → 跑 P1/N2/N3 → 对齐版本号。

反过来说，**队长也别忘了这一步**。三个人都 push 了、谁都没发布，线上还是三天前的版本，演示当天才发现是最难救的事故。

---

## 5. 常见问题

**线上打不开 / 403** —— 链接必须带 `?sharecode=YEX2LGOS5J`，裸域名会被拒。

**改了网页没反应** —— `⌘⇧R` 强制刷新；还不行动手检查 `index.html` 有没有引到你的文件。

**改了智能体没反应** —— 提示词是安装时读进内存的，必须重装 + 重启 WorkBuddy。

**地图一片灰** —— 要么用了 `mapStyleId`，要么公网没配 key 白名单，要么容器没有固定高度。

**智能体说「连不上记录库」** —— 当前会话没拿到云库工具，重启 WorkBuddy 重开一次；它这么说反而是对的，说明没编。

**白屏** —— 云 SDK 走 jsDelivr CDN，网络不通就白屏。提交前要把它内联进仓库（待办）。

---

## 6. 文档地图

| 想知道什么 | 看哪个文件 |
|---|---|
| 怎么装、怎么改、怎么协作 | `expert/README.md` |
| 改完怎么验、几条用例 | `expert/TESTING.md` |
| 项目整体是什么、线上地址 | `README.md` |
| 下一步计划、待办 | `docs/ROADMAP.md` |
| 登录闸门的设计理由 | `docs/PLAN-LOGIN-REQUIRED.md` |
| 公开信息分级（防泄题） | `docs/PLAN-PUBLIC-INFO.md` |
