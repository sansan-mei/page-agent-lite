# 架构与数据流

这是当前实现说明。目标是轻量浏览器 Agent，借鉴 Hermes 的运行器、工具、会话和上下文职责分离，不依赖 Hermes 进程。

实施方案见 [通用网页 Agent V1 实施规划](general-agent-v1.md)。V2 结果协议、有限条件检查和可恢复等待已实现；M4 局部读取与批量操作尚未实现。页面工具已补充视口优先抽取、容器四向滚动和受限点击事件兼容，仍保留预算与截断语义。

```text
sidepanel.html / sidepanel.js
          │ task:* 消息
background.js ── runtime.js ── prompts.js ── backend.js ── 模型 API
                      │             （密钥只在后台）
                 task-store.js
                      │
               storage.session
                      │
               browser-tools.js
                      │ tabs.sendMessage
                 content.js ── core.js ── 网页 DOM
```

## 模块边界

| 模块 | 职责 |
|---|---|
| `sidepanel.*` | 对话消息与工具请求/结果卡片、固定输入区、停止/继续；历史按钮列出会话内按标签页/origin 隔离的对话，按需只读查看详情，新对话位于顶部历史记录旁、清空位于记录页；没有执行循环 |
| `background.js` | 可信来源验证、组装依赖、事件唤醒与 alarm 调度 |
| `runtime.js` | 每次 tick 推进一步、预算、状态、重试、停止和恢复 |
| `tool-protocol.js` | V2 工具结果、稳定代码、旧返回适配，分开派发与证据 |
| `conditions.js` | 条件校验、语义目标绑定、唯一匹配的只读核对 |
| `site-memory.js` | IndexedDB 网站笔记、原子版本更新与取消；只有后台调用 |
| `task-store.js` | 会话任务读写、旧版数据迁移；后台统一写入 |
| `prompts.js` | 稳定模型指令和当前任务上下文组装 |
| `backend.js` | OpenAI 兼容调用、配置与文章存储 |
| `browser-tools.js` | 标签页检查、脚本注入、网页工具消息适配 |
| `content.js` | 短期快照、白名单动作、DOM 更新检查 |
| `core.js` | DOM 抽取、操作校验、字段事件和文章记录工具 |
| `article-tools.js` | 已退役的文章面板兼容源码，当前无界面入口或自动注入 |

任务不归属于 DOM 文档。翻页只更换内容脚本，后台从检查点重新观察。网页没有模型密钥，也不能通过消息创建、停止或读取后台任务。

## 生命周期

原生 JS、无构建。`sidePanel` 承载扩展 UI，`alarms` 为 worker 终止后恢复调度兜底；不新增全站预授权。短定时器用于连续交互，30 秒周期 alarm 用于唤醒，不能保证精确执行时间。

`tabs` 用于获取当前页元数据。侧边栏通过用户点击直接请求当前 origin，或 HTTP/HTTPS 全站可选权限；不是安装时预授全站权限。授权后以可信 task:connect 命令注入工具，失败时区分未授权与受保护页面。

worker 可能终止，必要状态写入 session。执行前保存 `executing`；恢复后有预期条件则仅核对，无条件则暂停，不重复点击。等待 deadline 不因恢复延长，详情见 [运行器](agent-runtime.md)。侧边栏关闭后继续运行；浏览器关闭后不运行。

## 取舍

不引入服务端、Python、向量库、MCP 或子 Agent。保留非流式 OpenAI 兼容接口和严格 JSON 工具协议。近期顺序见 [Roadmap](../ROADMAP.md)，网站长期笔记已接入，技能和跨会话任务恢复尚未实现。

参考：[Hermes 架构](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)、[Agent 循环](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)、[Chrome worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)。不代表项目具备 Hermes 全部能力。

页面内操作反馈由 `page-pointer.js` 管理，通过浏览器适配层随 core/content 注入；没有任务状态或模型访问。core 同步触发显示，动画与实际操作并行；后台运行器在停止/结束/非活动状态清理显示层。hover 复用当前快照目标校验、工具回执及观察核对流程。
