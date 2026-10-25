# dsh-prompt-rewrite · 输入框提示词改写

[English](./README.md) · [中文](./README.zh-CN.md)

发送前把草稿一键**改写为结构化提示词**：流式显示改写结果，可预览、可撤销，使用当前会话自己的模型。

## 快速开始

```sh
dsh plugin --profile web add dsh-prompt-rewrite
```

重启 Harness（或刷新 Web 界面）。输入框发送按钮旁会出现 ✨ **Optimize prompt** 控件。

## 功能

- **一键改写**：把口语化草稿变成清晰的纯文本、分段、或「角色·任务·目标」结构。
- **流式预览**：改写结果实时出现在输入框上方的面板里。
- **Use / Undo / Copy / Close**：点 **Use** 才会替换草稿，其余动作都不改内容。
- **用当前会话模型**：与下一轮对话同一条路由，无需另配 API key。
- **不写入会话日志**：改写过程不污染会话记录。
- 复用 [`oss-prompt-optimizer`](https://www.npmjs.com/package/oss-prompt-optimizer) 作为改写引擎。

## 命名说明

本插件以 `dsh-prompt-rewrite` 发布：npm 上 `dsh-prompt-optimizer` 这个名字属于另一位作者，两者无关。旧名 `@stijnus/dsh-prompt-optimizer` 已标记弃用并指向本包。

## 要求

DeepSeek Harness `>=0.2.1-rc.3 <0.3.0-0`，Web profile（桌面版或 Web 界面）

## 相关链接

- 英文说明（完整细节）：[README.md](./README.md)
- npm：<https://www.npmjs.com/package/dsh-prompt-rewrite>
- 更新记录：[CHANGELOG.md](./CHANGELOG.md)

<sub>同系列插件：[情绪板](https://github.com/Stijnus/dsh-moodboard) · [输入补全](https://github.com/Stijnus/dsh-composer-predictions) · [移动到工作区](https://github.com/Stijnus/dsh-move-to-workspace) · [工作区状态](https://github.com/Stijnus/dsh-workspace-status) · [提示词改写](https://github.com/Stijnus/dsh-prompt-optimizer)</sub>

<sub>⭐ 如果它帮你省了一步，点个 star 能让更多 DSH 用户发现它。</sub>
