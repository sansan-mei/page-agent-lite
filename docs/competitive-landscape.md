# 同类项目对照

核对日期 2026-11-23，依据各项目官方 README，未安装实测，未比较成功率；功能随版本变化。

| 项目 | 公开定位 | 与本项目的关系 |
|---|---|---|
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | Chrome/Edge 侧栏 Agent，自带 API/本机模型、多任务、记忆、长对话摘要、历史 | 最直接的插件竞品；侧栏、记忆、摘要本身不构成卖点 |
| [Alibaba Page Agent](https://github.com/alibaba/page-agent) | 页面内 JS Agent、文本 DOM 操作、自选模型，另有扩展做多页任务 | 轻量 DOM 路线相近、名称相近；它也面向网页集成，需区分产品身份。吸收计划见 [plans](plans/page-agent-integration.md) |
| [BrowserOS](https://github.com/browseros-ai/BrowserOS) | 独立 Agent 浏览器，可接 Claude Code、Codex、MCP 等，并行任务与回放 | 需安装独立浏览器，使用方式不同 |
| [Browser Use](https://github.com/browser-use/browser-use) | 开源浏览器 Agent 框架与云服务（Python、CDP） | 面向开发者和基础设施，不是纯插件 |

## 方向判断

聚焦：原生 MV3、无需 Python/守护进程、复用现有登录态；可审查的本机笔记；清楚区分操作派发、网页反馈和业务完成；中断后不重复结果未知的提交。差异应靠多网站实测的成功率、恢复能力和成本数据支撑，而不是功能列表。以上是基于公开定位的判断，不表示竞品缺少相同能力。
