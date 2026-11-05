# B 线开发指引（交互与定位）

> 给 B 同学：这份文档看完就能开工。你负责**上传体验、双入口首页、对话式录入、定位填写**。
> 代码边界很清晰：**你只改 3 个文件，别的文件一律不要动**，这样三个人才能同时干活不冲突。

---

## 0. 一次性准备（约 10 分钟）

### 0.1 装 Git

- **Windows**：装 Git for Windows → https://git-scm.com/download/win （全部默认下一步）。装完在文件夹里右键 → **Open Git Bash here**，后面所有命令都在这个窗口里敲。
- **Mac**：终端里执行 `git --version`，有输出就说明已装。

### 0.2 克隆仓库

```bash
git clone https://github.com/griffithnewber/lost_found.git
cd lost_found
```

### 0.3 用 WorkBuddy 打开这个文件夹

打开 WorkBuddy → 选择/打开工作目录为刚克隆的 `lost_found` 文件夹（不要打开上一级目录）。

**第一条指令建议这样发**（很重要，能防止 AI 把别人的代码重写掉）：

```
这是一个三人协作的前端项目，主文件是 index.html，逻辑拆在 assets/ 目录下。
我负责 assets/ui.js、assets/styles.css、assets/app.js 三个文件。
请只修改这三个文件，不要动 assets/api.js、ai.js、config.js、contact.js、search.js、match.js、stats.js，
也不要重写 index.html（如需新增 DOM，用 JS 动态创建）。
先读一遍 docs/GUIDE-B.md 和 docs/ROADMAP.md 了解约定。
```

### 0.4 每次开工前先拉最新代码

```bash
git pull
```

不拉就改，push 时必冲突。

---

## 1. 文件ownership：你只能改这三个

| 文件 | 谁改 | 说明 |
|---|---|---|
| `assets/ui.js` | **你** | 渲染、Toast、上传工具、弹窗、列表 |
| `assets/styles.css` | **你** | 所有样式（新样式写这里，或另建 `assets/ui-extra.css`） |
| `assets/app.js` | **你** | 流程编排：发布、检索、确认弹窗 |
| `assets/api.js` | A | 数据层，只调用不修改 |
| `assets/ai.js` | A | AI 调用，只调用不修改 |
| `assets/config.js` | A | endpoint / 模型配置，**绝对不要动** |
| `assets/contact.js` | A | 认领留言闭环，只调用不修改 |
| `assets/search.js` `match.js` `stats.js` | C | 检索算法、匹配分级、统计 |
| `index.html` | 共享 | 改结构前先在群里说一声 |

---

## 2. 你的三个任务（按顺序做，每个都能独立交付）

### 任务 1：粘贴 + 拖拽上传（最容易出效果，先做这个）

**要达成的效果**：发布页和检索页的图片，除了点“选择文件”，还支持
① 直接 `Ctrl+V / Cmd+V` 粘贴剪贴板里的图；
② 把图片文件拖到上传区域松手；
③ 拖拽经过时上传区高亮，并提示“松手即可上传”。

**实现要点**（可直接让 WorkBuddy 照这个写）：

```js
/* 1. 粘贴：监听 document，拿到剪贴板里的图片文件 */
document.addEventListener('paste', function (e) {
  var items = (e.clipboardData && e.clipboardData.items) || [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].type.indexOf('image') === 0) {
      e.preventDefault();
      handleImageFile(items[i].getAsFile());   // 复用你已有的读图流程
      return;
    }
  }
});

/* 2. 拖拽：给上传区域套一层 */
function enableDrop(zone, onFile) {
  ['dragenter', 'dragover'].forEach(function (k) {
    zone.addEventListener(k, function (e) { e.preventDefault(); zone.classList.add('dragging'); });
  });
  ['dragleave', 'drop'].forEach(function (k) {
    zone.addEventListener(k, function (e) { e.preventDefault(); zone.classList.remove('dragging'); });
  });
  zone.addEventListener('drop', function (e) {
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && /^image\//.test(f.type)) onFile(f);
    else LF.ui.toast('请拖入图片文件（jpg / png / webp）', 'error');
  });
}
```

**硬性要求**：

- 任何进来的图片都必须先经过 `LF.ui.compressImage()` 压缩（最长边 480、JPEG 0.75），**不能把原图直接入库**——原图几 MB，存几条数据库就卡死；
- 粘贴/拖拽成功后要给 Toast 反馈（“已粘贴图片”/“已载入图片”），并立即显示预览缩略图；
- 拖拽区要有 `.dragging` 高亮态（虚线边框 + 淡蓝底）；
- 移动端不支持拖拽，属正常，不用处理。

**验收**：在发布页按 `Cmd/Ctrl+V` 粘贴一张截图 → 立刻出现预览；拖一张图进去 → 出现预览；拖一个 PDF 进去 → 红字提示不支持。

---

### 任务 2：打开页面先选身份（双入口）

**要达成的效果**：进页面先出现一个选择界面：

```
┌─────────────────┬─────────────────┐
│  😢 我丢了东西   │  🙋 我捡到东西   │
│  发布失物信息    │  搜索并认领      │
└─────────────────┴─────────────────┘
```

点“我丢了东西” → 进发布面板；点“我捡到东西” → 进检索面板。
进面板后顶部保留一个“切换”入口，随时能改；记住上次选择（`sessionStorage`），刷新不用重选。

**实现要点**：

- 盖在页面上的一个 `.entry-mask`（`position:fixed; inset:0; z-index:60`），两个大卡片，点击后加 `.hide` 类淡出并从 DOM 移除；
- 选完调用已有的 tab 切换逻辑（`.tab[data-tab="publish"|"search"]` 触发 click 即可）；
- 不要删掉原来的 `.tabs`，它是“切换”入口的一部分。

**注意**：确认弹窗、留言弹窗的 `z-index` 都比它高，别把这件事搞反（弹窗是 50/60，选择页设 40 或点击后立即移除）。

---

### 任务 3：对话式录入 + 定位填写

#### 3.1 对话式录入（做成“分步气泡”，不要做真自由对话）

**推荐形态**：一个气泡对话式的向导，一步问一件事，用户答完自动进入下一步，左侧 AI 气泡、右侧用户回答：

```
🤖 丢的是什么？            →  用户：黑色雨伞
🤖 有照片吗？（可粘贴）     →  用户：[图片] / 跳过
🤖 大概在哪里丢的？         →  用户：[📍 用当前位置] 或手填
🤖 有没有别人不知道的细节？ →  用户：柄上有猫咪贴纸
🤖 确认发布               →  [发布]
```

**实现要点**：

- 用步骤数组驱动，别写成一堆 if：

```js
var steps = [
  { key: 'title',    ask: '丢的是什么？',            type: 'text',     required: true },
  { key: 'image',    ask: '有照片吗？可以粘贴或拖进来', type: 'image',    required: false, skippable: true },
  { key: 'location', ask: '大概在哪里丢的？',          type: 'location', required: false },
  { key: 'detail',   ask: '有没有别人不知道的细节？',    type: 'textarea', required: true,
    hint: '比如贴纸、划痕、里面装了什么——只有真失主答得上来' }
];
```

- 每步把答案存进一个 `draft` 对象，**最后一次性调用已有的 `LF.api.createItem()`**，不要每步都写库；
- 必须有“上一步”（回退时保留已填内容）和“跳过”（仅 `skippable: true` 的步骤）；
- 隐藏细节那一问要强调“不会被别人看到”，这是用户愿意填的关键；
- 发布中要有 loading 态（发布时 AI 要识别图片，通常 2–5 秒）；
- 语音输入不用做，`input` 上加 `enterkeyhint` 就够移动端体验。

**发布成功后的清理**：清空 draft、清预览、`renderMyPosts()` 刷新“我的发布”、Toast 提示。

#### 3.2 定位填写（有合规红线，按这个做）

**要做的**：位置输入框旁边加一个「📍 用当前位置」按钮，点击后调用浏览器定位。

```js
function locate() {
  if (!navigator.geolocation) { LF.ui.toast('当前浏览器不支持定位，请手动填写', 'error'); return; }
  LF.ui.toast('正在获取位置…', 'info', 1200);
  navigator.geolocation.getCurrentPosition(
    function (pos) {
      // ✅ 坐标只在本机用于提示，绝不写入数据库、绝不上传
      var lat = pos.coords.latitude.toFixed(4);
      var lng = pos.coords.longitude.toFixed(4);
      showLocateHint('已定位（' + lat + ', ' + lng + '），请补一句具体地点，例：图书馆三楼东侧靠窗');
      document.getElementById('pub-location').focus();
    },
    function () {
      LF.ui.toast('定位失败或未授权，可手动填写地点', 'error');
    },
    { timeout: 8000, maximumAge: 60000, enableHighAccuracy: false }
  );
}
```

**三条必须遵守的规则**（否则线上会被合规检查卡住，见 `docs/ROADMAP.md` 的“合规章节”）：

1. **坐标不落库**。数据库里的 `location` 字段只存用户确认过的**文字地点**（“三教二楼西侧”），绝不存经纬度——那等于公开他人位置数据；
2. **必须保留手填**。拒绝授权、定位失败、室内漂移，都要能正常手填，不能把定位设成必填；
3. **不要自己接地图 JS SDK**（高德/百度/腾讯地图的 Key 会暴露在前端，且国内地图服务有资质要求）。如果确实要做“坐标 → 文字地址”的逆地址解析，先找组长，由 A 走云服务代理，Key 不出现在浏览器里。

**用户拒绝授权时**：给一句人话提示（“没关系，手动写个大概位置就行”），不要弹系统级错误。

---

## 3. 你可以直接用的接口（A 已实现并测通）

### 数据层 `LF.api`

| 方法 | 说明 |
|---|---|
| `await LF.api.listItems()` | 全部物品（含已找回） |
| `await LF.api.listPublicItems()` | **广场可见**（已找回的会被过滤）← 检索用这个 |
| `await LF.api.listMyItems()` | **我的发布**（只含本机发布的） |
| `await LF.api.createItem({...})` | 发布，返回 `{ok, id}` |
| `await LF.api.updateItem(id, {status})` | 改状态：`open` / `claimed` / `returned` |
| `await LF.api.deleteItem(id)` | 删除 |
| `await LF.api.listMessages(itemId?)` | 留言（不传 id 则取全部） |
| `await LF.api.sendMessage({...})` | 发留言 |

### 视图层 `LF.ui`

`toast` / `esc` / `fileToDataURL` / `compressImage` / `extractColorFeature` / `colorDistance` /
`renderMyPosts` / `renderResults` / `openModal` / `closeModal` / `chatClear` / `chatMsg` /
`setAction` / `showAnswerInput` / `setBusy` / `showMatchSuccess` / `setStatus`

### 认领留言 `LF.contact`（A 新增，修改样式时别改掉这些属性）

| 用法 | 说明 |
|---|---|
| `<button data-thread="物品id">💬 留言</button>` | 失主查看/回复留言；点击由 `contact.js` 接管，你只管放按钮 |
| `<button data-contact="物品id">✉️ 联系失主</button>` | 找东西的人主动留言（检索结果卡片可加） |
| `<span data-msgcount="物品id"></span>` | 留言数角标，会被自动写入，别删这个属性 |
| `LF.contact.openFinder(item)` / `openThread(item)` | 需要主动调起时用 |

---

## 4. 本地怎么预览

**能本地看的**：布局、配色、粘贴/拖拽、双入口、分步表单、定位（这些是纯前端）。

**不能本地看的**：云端读写、AI 识别、留言——云服务有域名白名单，`file://` 和 `localhost` 都会被拦。

所以：

```bash
# 在项目根目录起一个本地服务（只是看静态效果）
python3 -m http.server 8080      # Windows 可用 python -m http.server 8080
# 浏览器打开 http://localhost:8080
```

打开后你会看到右上角“⚠️ 云端同步失败”，这是**预期现象**，不影响你调样式和交互。
需要看真实云端效果 → 等组长发布后，用线上链接看。

---

## 5. 提交与发布（重要）

改完后：

```bash
git pull                     # 先拉别人的改动
git add -A
git commit -m "feat(ui): 支持粘贴/拖拽上传 + 双入口 + 分步录入 + 定位按钮"
git push
```

首次 push 会要求填 **Username**（你自己的 GitHub 用户名）和 **Password**（你自己的 Personal Access Token，不是登录密码）。

### ⚠️ push 完网站不会自动更新

线上跑的是**组长那台电脑发布出去的版本**。你 push 的代码只是进了仓库。所以：

1. push 成功后，在群里 @ 组长，发这一句：

```
已推送到 main（提交：xxxxx），改动是：粘贴/拖拽上传 + 双入口 + 分步录入 + 定位。
麻烦拉取并重新发布，谢谢！
```

2. 组长在 WorkBuddy 里说一句“拉取最新代码并重新发布”，线上链接不变、刷新即新版；
3. 组长发布完会回你一句“已发布”，你再去线上链接验收。

**不要去自己发布**（WorkBuddy 里不要点“发布/部署”），线上只有一个正式入口，由组长统一发布。

---

## 6. 自测清单（push 之前过一遍）

- [ ] 发布页：`Cmd/Ctrl+V` 粘贴截图 → 有预览、有 Toast
- [ ] 发布页：拖拽图片进入 → 区域高亮、松手后有预览
- [ ] 发布页：拖入非图片文件 → 红字提示，不会崩
- [ ] 首次打开 → 出现双入口，两个按钮都能正确进入对应面板
- [ ] 双入口选择后刷新页面 → 不重复弹出（或可切换）
- [ ] 分步录入：能上一步、能跳过照片、必填项为空时有提示
- [ ] 分步录入：走完全程能发布成功（线上链接测试）
- [ ] 定位：允许授权 → 有提示；拒绝授权 → 有提示且能手动填
- [ ] 手机浏览器（可选）：布局不塌、按钮可点
- [ ] 控制台无红色报错
- [ ] `git status` 里没有把 `assets/config.js` 等别人的文件改进去

---

## 7. 常见坑

| 现象 | 原因 / 解决 |
|---|---|
| 页面右上角“⚠️ 云端同步失败” | 本地 `file://` / `localhost` 打不开云端，属正常；线上链接才正常 |
| 发布失败 `row level security` | 数据库权限问题，找 A，不要自己改 |
| 粘贴没反应 | 焦点在 `textarea` 里时浏览器会优先粘贴文本；监听 `document` 的 paste 并判断 `clipboardData.items` |
| 图片很大导致发布卡住 | 忘了走 `LF.ui.compressImage()` |
| push 报 `403` | 组长还没把你加进仓库协作者，或 Token 没勾 `repo` 权限 |
| push 报 `rejected (fetch first)` | 别人先推了，`git pull` 后再 push（有冲突找组长） |
| 引用 `LF.search.xxx` 报 undefined | 脚本顺序：`config → api → ai → ui → search → match → stats → app → contact`，改 `index.html` 时别打乱 |

---

## 8. 你改完之后，A 还能接什么

留个念想，不用现在做：

- 检索结果卡片上加「✉️ 联系失主」按钮（`data-contact="id"`），让没通过 AI 核验的人也能留言；
- “我的消息”页面：让找东西的人也能看到失主的回复；
- 发布成功后生成分享卡片（截图/二维码），方便发到班级群。

有拿不准的地方，直接在群里问，或者把报错贴给组长。
