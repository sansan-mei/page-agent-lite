# 同类项目对照

核对日期：2026-11-23（Asia/Singapore）。以下按项目官方 README 整理，不代表已安装实测或完成全量市场调查；未比较任务成功率。功能与定位随版本变化。

| 项目 | 已公布定位与能力 | 与本项目的关系 |
|---|---|---|
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | Chrome/Edge 侧栏浏览器 Agent，自带 API/本机模型、网页操作、多任务、记忆、长对话摘要和历史 | 最直接的插件竞品；单靠侧栏、记忆、摘要不能形成独有卖点 |
| [Alibaba Page Agent](https://github.com/alibaba/page-agent) | 页面内 JavaScript Agent、文本 DOM 操作、自选模型，另有 Chrome 扩展用于多页任务 | 轻量 DOM 路线相近，名称也相同；它同时面向网页集成，应区分产品身份 |
| [BrowserOS](https://github.com/browseros-ai/BrowserOS) | 独立的 Agent 浏览器，可连接 Claude Code、Codex、Hermes/MCP 等，支持并行任务和会话回放 | 邻近方案，需安装独立浏览器，与现有浏览器直接加载插件的使用方式不同 |
| [Browser Use](https://github.com/browser-use/browser-use) | 浏览器 Agent 开源框架和云服务，当前公开方案包含 Python REPL/CDP 与浏览器自动化基础设施 | 更偏开发者和基础设施，争夺自动化任务需求，但不是同形态的纯插件 |

## 本项目方向判断

建议聚焦：原生 MV3、无需 Python/守护进程、复用现有登录态；可审查的网站笔记；对操作派发、网页反馈和业务完成作清晰区分；中断后不重复结果未知的提交。以多网站实测的成功率、恢复能力和成本数据支撑差异，而非只比较功能列表。

这属于基于公开定位的产品判断，不表示上述项目缺少相同能力。本站长期笔记本次新增已验证本机持久化链路，尚未证明会自动积累高质量技能，也不能据此声称优于竞品。

## Page Agent 后续吸收

已按上游公开源码整理 [专项实施计划](page-agent-integration-plan.md)，区分本项目已有基础、待增强能力和可选集成。网页执行优先；SDK、扩展 API、MCP 属后期评估，不代表当前已接入或需要运行上游服务。
