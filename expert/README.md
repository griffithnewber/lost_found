# 智能体协作手册 · 寻物官 · 阿寻

三个人共同维护这一个智能体，**只需要读这一页**。看完你就知道：它是什么、怎么装、怎么改、改完怎么验、谁能改哪块。

---

## 0. 先建立两个正确认知

**① 智能体不是程序，是一份提示词。**
整个智能体 = `agents/lost-found-assistant.md`（约 8KB 的 Markdown）+ 一份元信息（`plugin.json`，管名字、简介、快捷提示词、头像）。WorkBuddy 把这份 md 当系统提示词加载，模型照着它说话。所以「改智能体」= 改文字，不写代码、不编译、不部署。

**② 改了不会自动生效，而且只在自己电脑上生效。**
专家包是**纯本地资产**，存在每个人自己的 `~/.workbuddy/plugins/marketplaces/my-experts/plugins/` 里，没有云同步、没有分享链接。git 只负责保存文本，不负责分发安装。所以每次改完，每个人都要**自己重装一次**。

---

## 1. 仓库里跟智能体有关的文件

```
expert/
├── README.md                       ← 你正在读的这页
├── TESTING.md                      ← 改完必跑的冒烟用例（提示词的「回归测试」）
├── build.sh                        ← 打包成 docs/lost-found-assistant.zip
└── lost-found-assistant/
    ├── .codebuddy-plugin/plugin.json   # 元信息：名字、简介、3 个快捷提示词、版本号
    ├── agents/lost-found-assistant.md  # ★ 核心：全部行为规则，99% 的改动在这里
    ├── avatars/expert.png              # 头像 512×512
    └── README.md                       # 对外介绍（给评委看的）
```

`expert/` 之外的 `assets/*.js`、`index.html` 是**网页版**，和智能体是两套东西，互不影响，但共享同一套云数据库表结构（见第 6 节坑 1）。

---

## 2. 第一次安装（每人做一次）

### 方式 A：导入 zip（推荐，最不容易出错）

```bash
bash expert/build.sh          # 产出 docs/lost-found-assistant.zip
```

把 zip 拖进 WorkBuddy 对话框，说「导入这个专家包」。它会自己解压、校验、注册。重启后在左侧「专家」里看到「寻物官 · 阿寻」就是成功了。

### 方式 B：拷目录 + 注册（改完代码后日常用这个）

```bash
rm -rf ~/.workbuddy/plugins/marketplaces/my-experts/plugins/lost-found-assistant
cp -R expert/lost-found-assistant ~/.workbuddy/plugins/marketplaces/my-experts/plugins/
```

**只拷目录还不够**——还需要在 `marketplace.json` 里登记，否则专家中心不显示。最省事的办法：拷完之后跟 WorkBuddy 说一句「注册一下 my-experts 里的 lost-found-assistant」，它会跑注册脚本。第一次装建议直接用方式 A。

重启 WorkBuddy 生效。

---

## 3. 日常修改流程

```bash
git pull                                   # 1. 先同步，别在旧版本上改
git checkout -b agent/verify-question       # 2. 开分支，别直接推 main
# 3. 改 expert/lost-found-assistant/agents/lost-found-assistant.md
bash expert/build.sh                       # 4. 重新打包
# 5. 按 TESTING.md 跑一遍冒烟用例，三条都得过
git commit -am "feat(agent): 核验提问改为不给选项"
git push -u origin agent/verify-question   # 6. 推分支
```

然后开 PR，至少一个人 review 过再合。**别直接推 main**——三个人同时动一个 md 文件，冲突起来很难看。

合并后，每个人各自执行第 2 节的方式 B，重装一次。

### 分支命名

`agent/xxx` 改提示词，`web/xxx` 改网页，`docs/xxx` 改文档。一眼看得出动了哪块。

### 版本号怎么升

改 `plugin.json` 里的 `version`，让三个人一眼看出谁装的是旧版：

| 改动 | 版本 |
|---|---|
| 只改措辞、错别字、标点 | `1.0.0 → 1.0.1` |
| 新增能力或改了流程（如加「交接凭证」） | `1.0.0 → 1.1.0` |
| 重写整个结构（如从三分支改成五分支） | `1.0.0 → 2.0.0` |

现场演示前对一下版本号，不一致就当场重装，别带着两个版本上台。

---

## 4. 改完必须验证

提示词没有编译器，所以**验收靠用例**。`expert/TESTING.md` 里有 6 条固定用例：3 条正向（登记 / 匹配 / 核验要能跑通）、3 条反向（不许泄题、不许张冠李戴、不许编造记录）。

每次改完至少跑正向 3 条 + 跟你改动相关的反向用例。跑不过就别合。

---

## 5. 三个人怎么分工不打架

| 谁 | 负责 |
|---|---|
| A | `agents/lost-found-assistant.md`：提示词、核验策略、话术 |
| B | 网页版 UI 与广场（`ui.js` / `styles.css` / `app.js`）；智能体 README 与演示截图 |
| C | 匹配算法（`search.js` / `match.js`）；智能体「匹配理由」表述的准确性把关 |
| 共同 | 提交前跑三条演示路径，确认智能体话术和网页里的数据对得上 |

**最大的协作风险：md 是单个文件。** 两个人同时改不同段落，git 也会冲突（因为上下文贴得太近）。两条约定：

1. 动笔前在群里说一句「我在改核验那段」，别人先避开；
2. 一次只改一段，别顺手重排全文、别调整空行——格式化噪声会把真正的改动淹没。

---

## 6. 五个坑（按踩到概率排序）

**坑 1 · 字段对不上（最容易出事）**
智能体写云库时按 `lost_items` 的字段落库：`title` / `notice` / `detail` / `location` / `post_type` / `status` / `pub_time`。
谁改了网页的表结构或字段名，**必须同步改 md 里「数据与工具」那一节**，否则智能体登记会静默写错列。

**坑 2 · 它嘴上说有，其实没查**
现在这版还没有真正接通数据库（提示词里没给 `applicationId`），所以它会「演」——说「记录里没有」但根本没查过，甚至把黑色耳机说成粉色学生证。这是当前要修的头号问题，不是模型笨。

**坑 3 · 模型选错**
用「快速」档（DeepSeek-V4.1-Flash，约 0.18 积分/轮）跑，长提示词遵从度弱，容易漏规则。演示用强一点的模型，日常调试可以用快速档省钱。

**坑 4 · 改了没重装**
最常见的「怎么没生效」：文件改了、git 推了，但本地装的那份还是旧的。记住提示词是安装时读进去的。

**坑 5 · 隐藏细节泄露**
md 里「铁律」第 1 条是硬约束：隐藏细节不能出现在公开卡片、匹配理由、核验提问、拒绝理由里。任何新增话术都要过这一条，`TESTING.md` 的反向用例就是查这个。

---

## 7. 提交前的清单

- [ ] `bash expert/build.sh` 打包成功，`docs/lost-found-assistant.zip` 已更新并入库
- [ ] `plugin.json` 版本号已升
- [ ] `TESTING.md` 正向 3 条全过，反向用例全过
- [ ] 三个人本地装的版本号一致
- [ ] 演示用的云端记录里有至少一条 `status = open` 的，否则核验流程无对象可演
- [ ] 改动涉及的段落没把「铁律」删掉或改软
