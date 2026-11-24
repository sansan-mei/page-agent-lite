# 架构

轻量浏览器 Agent：后台 service worker 跑任务循环，内容脚本只提供网页工具，侧栏和设置页只发命令。借鉴 Hermes 的运行器/工具/会话/上下文职责划分，但不依赖其进程。

```text
sidepanel.js ─┐ task:* 消息（可信扩展页）
options.js  ──┤
              ▼
background.js ── runtime.js ── prompts.js ── backend.js ── 模型 API（密钥只在后台）
                    │    │
                    │    └── site-memory.js ── IndexedDB
                    ├── task-store.js ── storage.session
                    └── browser-tools.js ── tabs / scripting
                              │ agent:* 消息
                         content.js ── core.js ── 网页 DOM
                                       page-pointer.js（视觉反馈）
```

## 模块

| 文件 | 职责 | 详细文档 |
|---|---|---|
| `background.js` | 校验消息来源（仅顶层可信扩展页）、装配依赖、标签/权限事件、timer 与 alarm 调度 | [运行器](agent-runtime.md) |
| `runtime.js` | 任务状态机：每 tick 推进一步、预算、检查点、等待、恢复、取消、跨来源切换、诊断 | [运行器](agent-runtime.md) |
| `prompts.js` | 稳定系统指令与每轮上下文组装 | [上下文](context-and-skills.md) |
| `backend.js` | 配置读写、OpenAI 兼容请求与响应解析（`parseChatResponse`）、文章存储（兼容） | [上下文](context-and-skills.md) |
| `task-store.js` | session 任务根记录、归属索引、对话历史、迁移与中断对账 | [存储](storage.md) |
| `site-memory.js` | IndexedDB 网站/全局长期笔记，版本 CAS | [存储](storage.md) |
| `browser-tools.js` | 标签检查、脚本注入、权限/来源门禁、导航派发、网页工具消息适配 | [网页工具](browser-tools.md) |
| `content.js` | 一次性快照、执行白名单动作、动作后短观察、只读核对 | [网页工具](browser-tools.md) |
| `core.js` | DOM 抽取、动作校验与执行、静态工具注册表 `agentToolRegistry`、敏感字段排除 | [网页工具](browser-tools.md) |
| `conditions.js` | expected 条件校验、语义目标绑定、唯一匹配核对 | [网页工具](browser-tools.md) |
| `tool-protocol.js` | V2 工具结果、稳定 code、旧返回适配 | [网页工具](browser-tools.md) |
| `page-pointer.js` | 页面内虚拟指针与高亮，无任务状态、无模型访问 | [网页工具](browser-tools.md) |
| `sidepanel.*` | 对话、工具卡片、历史、任务范围、接管；没有执行循环 | [使用指南](usage.md) |
| `options.*`、`management.js`、`global-management.js` | 设置页；网站/临时记忆管理；全局记忆管理 | [使用指南](usage.md) |
| `welcome-image.js` | 侧栏主图上传、缩放与同步（设置页和侧栏共用） | [存储](storage.md) |
| `i18n.js`、`_locales/{zh_CN,en}/messages.json` | 界面文案：`PageAgentI18n.t(key, ...)` 经 `chrome.i18n` 取词（`{1}` 占位，文案不用 `$`），`data-i18n*` 属性翻译静态 HTML；`defaultReplyLanguage()` 按界面语言给出默认回复语言。manifest 名称、说明、工具栏提示用 `__MSG_*__` | [使用指南](usage.md#界面语言) |
| `script-tools.js` | run_script：参数校验、可用性检查、经 `userScripts.execute` 执行、提示词与 tool schema；后台与设置页加载，内容脚本不加载 | [网页工具](browser-tools.md#run_script) |
| `script-settings.js` | 设置页「脚本执行」：点击申请可选 `userScripts` 权限、显示状态 | [使用指南](usage.md#脚本执行) |
| `article-tools.js` | 已退役文章面板的兼容源码，无入口、不自动注入 | — |
| `dev/`（不在 `extension/`） | 开发版叠加：`dev-flags.js`（run_script 免批准）、`background-dev.js`，由 `npm run build:dev` 生成 `dist/extension-dev/` | [网页工具](browser-tools.md#run_script) |

## 消息入口

- 侧栏 → 后台：`task:submit`、`task:resume`、`task:stop`、`task:finish`、`task:clear`、`task:takeover`、`task:choose`、`task:approve`（旧确认兼容）、`task:get`、`task:connect`、`task:history`、`task:history-get`、`task:diagnostics`、`task:scope-change`、`task:members`、`task:member-change`、`task:sensitive-access`、`task:script-approval`。
- 设置页 → 后台：`task:memory`、`task:memory-clear`、`task:site-memory`、`task:site-memory-change`、`task:global-memory`、`task:global-memory-change`。
- 后台 → 内容脚本：`agent:observe`、`agent:execute`、`agent:verify`、`agent:prepare-navigation`、`agent:document`（只读文档 ID 探测）、`agent:clear-pointer`。

网页不能创建、停止或读取任务，拿不到密钥、配置或记忆。内容脚本只接受后台消息，不直接导航、不保存任务目标。

## 权限与信任边界

- 安装时权限：`tabs`、`scripting`、`storage`、`sidePanel`、`alarms`。主机权限是可选的 `http://*/*`、`https://*/*`，只由用户手势申请。`userScripts` 是可选权限，只在设置页点击时申请（安装不提示）；本地开发版改为必需权限。
- 浏览器内部页可承载对话，不注入或读取 DOM；进入普通网页前仍须授权目标来源。
- 导航要求浏览器主机权限，不再要求逐站加入任务；来源切换自动记录目标并隔离旧站点上下文。读取和操作仍绑定任务当前来源。
- `storage.local` 初始化时限定为 `TRUSTED_CONTEXTS`；API 不可用则拒绝初始化。
- 动作必须在 `agentToolRegistry` 中（冻结对象，运行时不可注册）；内容执行器拒绝 runtime/browser 路由的动作。模型生成的代码只能经 run_script 由 `userScripts` 执行，商店包每次须侧栏批准。

## 生命周期

- 原生 JS，商店包无构建（开发版只做复制叠加）。worker 会被浏览器终止：短定时器驱动连续 tick，30 秒周期 alarm 兜底唤醒，必要状态都写 session。
- 任务不属于某个 DOM 文档：翻页只替换内容脚本，后台按检查点重新观察。
- 侧栏关闭后任务继续；浏览器关闭后不运行，session 可能被清空。

## 取舍

不引入服务端、Python、向量库、MCP 或子 Agent；保留非流式 OpenAI 兼容接口；动作默认走原生 function calling，不支持时回退严格 JSON，两者共用同一注册表与校验。后续计划见 [Roadmap](../ROADMAP.md)。

参考：[Hermes 架构](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)、[Chrome worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)。
