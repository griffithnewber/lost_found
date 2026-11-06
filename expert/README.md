# 智能体部分（寻物官 · 阿寻）协作说明

这个目录是提交给比赛的**智能体源码**。网页版（仓库根目录的静态站 + 云数据库）和它是两套东西，改哪个、谁改，按下面来。

## 目录里有什么

```
expert/lost-found-assistant/
├── .codebuddy-plugin/plugin.json   # 专家元信息：名字、简介、三个快捷提示词
├── agents/lost-found-assistant.md  # 核心：智能体的全部行为规则（提示词）
├── avatars/expert.png              # 头像 512×512
└── README.md                       # 对外介绍
```

**要改智能体的行为，只改 `agents/lost-found-assistant.md`。** 它就是一个 Markdown 提示词文件，不涉及代码。

## 队友怎么改

```bash
git pull
# 编辑 expert/lost-found-assistant/agents/lost-found-assistant.md
git commit -am "feat(agent): 调整核验提问方式"
git push
```

改完要让它在自己的 WorkBuddy 里生效，需要重装一次（提示词是在安装时读进去的）：

```bash
# 1. 覆盖本地已安装版本
rm -rf ~/.workbuddy/plugins/marketplaces/my-experts/plugins/lost-found-assistant
cp -R expert/lost-found-assistant ~/.workbuddy/plugins/marketplaces/my-experts/plugins/

# 2. 重启 WorkBuddy，去「专家」里重新打开「寻物官 · 阿寻」
```

或者直接打包成 zip，用专家中心的导入功能装：

```bash
bash expert/build.sh
# 产出 docs/lost-found-assistant.zip
```

## 两个人同时改会怎样

- **互不覆盖**：和代码一样走 git，冲突了正常解。
- **各自生效**：智能体是本地安装的，你 push 完不会自动出现在队友的 WorkBuddy 里，他得 `git pull` + 重装（上面两行命令）。
- **线上链接**：比赛提交的那个链接背后是**你账号里注册的那一份**，队友本地改的东西不会改变它。要更新线上版本，得由你在自己这边重装后再重新打包/注册。

## 最容易踩的坑：字段对不上

智能体写云库时按 `lost_items` 表的字段落库（`title` / `notice` / `detail` / `location` / `post_type` / `status` / `pub_time`）。
**如果有人改了网页版的表结构或字段名，一定要同步改 `agents/lost-found-assistant.md` 里「数据与工具」那一节的映射**，否则智能体登记会失败或写错列。

## 分工建议

| 谁 | 负责 |
|---|---|
| A | `agents/lost-found-assistant.md`（提示词、核验策略、话术） |
| B | 网页版 UI 与广场（`ui.js` / `styles.css` / `app.js`），智能体 README 与截图 |
| C | 匹配算法（`search.js` / `match.js`），以及智能体侧「匹配理由」的表述校验 |
| 共同 | 提交前跑一遍三条演示路径，确认智能体话术与网页数据一致 |
