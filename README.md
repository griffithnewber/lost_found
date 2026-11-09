# 失物招领 · 智能匹配（三人协作项目）

> **队友先看 [`TEAM-START.md`](TEAM-START.md)** —— 一份文件讲清怎么跑起来、现在能做什么、怎么不撞车。需要深入时再看 [`START-HERE.md`](START-HERE.md)（网页侧手册）。

基于单文件 HTML + 原生 JS 的失物招领原型，已接入 WorkBuddy 云服务实现多设备数据共享。

## 线上地址

https://lost-found-56662.app.workbuddy.host/?sharecode=LOJRSCWJAA

任何人打开该链接即可**浏览广场、绑定编号、补照片、收发留言**；数据的写入（登记 / 匹配 / 核验 / 改状态）全部在聊天框里由智能体「寻物官 · 阿寻」完成。数据存在云端数据库（`lost_items` 表），所有设备共享同一份数据。

> 注意：链接必须带 `?sharecode=LOJRSCWJAA` 整段复制，删掉参数会 403。

## 两部分，分开维护

| | 是什么 | 怎么改 | 维护手册 |
|---|---|---|---|
| **智能体** | 「寻物官 · 阿寻」，对话式完成登记/匹配/核验，比赛提交的主体 | 改 `expert/lost-found-assistant/agents/lost-found-assistant.md`（一份提示词，不写代码） | **[`expert/README.md`](expert/README.md)** 与 [`expert/TESTING.md`](expert/TESTING.md) |
| **网页版** | 只读看板：广场 + 信箱（v1.12.0 起发布/检索/核验已下线） | 改 `assets/*.js`，发版要改 `?v=` 并由队长重新发布 | 本文档下文 |

## 项目结构

```
index.html            # 网页版主应用（广场 + 信箱，只读看板）
assets/               # 网页版模块：api / auth / ui / square / contact / mailbox / notify / ai
expert/               # 智能体源码与协作手册（见 expert/README.md、expert/TESTING.md）
docs/                 # 计划文档 + 打包好的智能体 zip + 工作记录
lost_found_v2.html    # 归档：第一阶段本地版（localStorage）
lost_found_cloud.html # 归档：LeanCloud 方案（该平台已停止注册，仅留参考）
```

## 团队协作流程

1. 克隆仓库：`git clone https://github.com/griffithnewber/lost_found.git`
2. 改代码前先拉最新：`git checkout main && git pull`
3. **开分支改，不要直接推 main**：
   ```bash
   git checkout -b web/square-mobile
   git commit -am "web: 广场 375px 适配"
   git push -u origin web/square-mobile
   ```
4. 在 GitHub 开 PR，正文贴 `expert/TESTING.md` 的用例记录（跑过的打 ✅）
5. **合并后由队长发版**：网页要改 `?v=` + 重新发布；智能体要升版本号 + `bash expert/build.sh` + 发 zip 给所有人重装
6. 遇到冲突先 `git pull` 手动合并；改同一处文件前先在群里说一声

> 完整协作规范见 [`TEAM-START.md`](TEAM-START.md)，含发版流程、版本号规则和六个高频坑。

## 技术要点

- 数据层：WorkBuddy 云数据库（CDN 引入 `@tencent-ai/workbuddy-cloud-sdk`），localStorage 仅作离线缓存
- 智能体数据通道：MCP 云库工具（首选）→ 公开 REST（`/.cloud/database/rest` + `x-wb-webapp-access-key` 头，任何账号可用）
- 匹配与核验：由智能体提示词完成（语义理解 + 分级阈值 + 隐藏细节核验），网页不再做检索打分
- 图像能力：登记时由多模态模型生成 `ai_desc`（只用于打分、永不复述），8x8 颜色特征作辅助
