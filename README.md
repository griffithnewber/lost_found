# 失物招领 · 智能匹配（三人协作项目）

基于单文件 HTML + 原生 JS 的失物招领原型，已接入 WorkBuddy 云服务实现多设备数据共享。

## 线上地址

https://lost-found-75068.app.workbuddy.host/?sharecode=YEX2LGOS5J

任何人打开该链接即可发布、检索失物；数据存在云端数据库（`lost_items` 表），所有设备共享同一份数据。

## 两部分，分开维护

| | 是什么 | 怎么改 | 维护手册 |
|---|---|---|---|
| **智能体** | 「寻物官 · 阿寻」，对话式完成登记/匹配/核验，比赛提交的主体 | 改 `expert/lost-found-assistant/agents/lost-found-assistant.md`（一份提示词，不写代码） | **[`expert/README.md`](expert/README.md)** 与 [`expert/TESTING.md`](expert/TESTING.md) |
| **网页版** | 可视化广场，看得到全部记录和状态 | 改 `assets/*.js` | 本文档下文 |

## 项目结构

```
index.html            # 网页版主应用（发布/检索/AI确认/云端同步）
assets/               # 网页版模块：api / auth / search / match / mailbox / ui 等
expert/               # 智能体源码与协作手册（见 expert/README.md）
docs/                 # 计划文档 + 打包好的智能体 zip
lost_found_v2.html    # 归档：第一阶段本地版（localStorage）
lost_found_cloud.html # 归档：LeanCloud 方案（该平台已停止注册，仅留参考）
```

## 团队协作流程

1. 克隆仓库：`git clone https://github.com/griffithnewber/lost_found.git`
2. 改代码前先拉最新：`git pull origin main`
3. 修改 `index.html` 后提交：
   ```bash
   git add index.html
   git commit -m "说明你改了什么"
   git push origin main
   ```
4. 代码合并到 main 后，由仓库所有者在本机重新发布一次（公网链接不变，内容更新）。
5. 遇到改动冲突时，先 `git pull` 手动合并再推送；改同一处文件前先在群里说一声。

## 技术要点

- 数据层：WorkBuddy 云数据库（CDN 引入 `@tencent-ai/workbuddy-cloud-sdk`），localStorage 仅作离线缓存
- 语义检索：前端 2-gram + 同义词扩展，Dice 相似度（第二阶段计划换真实 Embedding）
- 图像检索：8x8 降采样颜色特征，欧氏距离（第二阶段计划换 CLIP）
- AI 确认：本地规则模拟（第二阶段计划换成真实 LLM API，出题判答移到服务端）
