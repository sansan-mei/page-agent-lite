# Page Agent 能力吸收计划

把 [alibaba/page-agent](https://github.com/alibaba/page-agent) 中适合本项目的机制，适配进原生 MV3 扩展。上游核对版本 `d8dd334487cb2de14206aa8ca939a1613cd612dc`（静态阅读源码，未做同任务对测）。当前实现细节以模块文档为准，本文只记状态和剩余计划。

## 原则

- 适配机制或有来源地局部移植，不替换运行器，不打包上游 TypeScript monorepo。直接复制代码须保留 MIT 版权与来源，并核对其 browser-use 衍生部分的归属。
- 按通用控件和框架行为实现，不加网站专用动作；不无条件向主世界注入框架补丁。
- 不吸收：模型执行 JavaScript 的实验工具、可被网页覆盖的系统提示、任意内容回调、上游的整套依赖和构建、逐次审批。
- 每项单独实现、测试、回退；用成功率、重复副作用、请求数/token、人工介入衡量，不以工具数量论效果。

## 状态

| 编号 | 方向 | 已实现 | 剩余 |
|---|---|---|---|
| PA1 | 语义 DOM 与长页面读取 | 正文/控件/区域/单区域分段与查找；语义祖先路径与描述 | — |
| PA2 | 受控表单与自定义控件 | 原生 setter、可取消 beforeinput、值清洗检查；ARIA listbox 分组与状态核对 | IME 组合输入、日期等复合控件、真实框架验证 |
| PA3 | contenteditable | 简单纯文本 | 常见编辑器适配评估 |
| PA4 | 控制器边界与用户接管 | 「我来操作」后重新观察 | 无需求不做大规模重构 |
| PA5 | 快照效率 | `includeText:false` 省略正文；`fill_fields` 一轮写 2–8 个字段，逐项核对，页面变化即停 | 快照差异不做：每轮是单条用户消息，模型看不到上一份快照，差异无法省 token（改多轮消息时再评估）；点击类批量不做 |
| PA6 | 子目标与证据驱动重规划 | 公开 subgoals，完成须条件核对 | 与技能闭环衔接 |
| PA7 | 可信导航与任务站点集合 | 单标签跨已授权来源导航、范围面板、权限门禁 | — |
| PA8 | 任务拥有的标签集合 | 单成员根记录、任务级调度、单成员关闭；用户加入/移出与成员目录 | 切换、open/close、多成员关闭，见 [设计](task-scope-v3.md) |
| PA9 | 可信工具注册与 hooks | 静态冻结动作策略 | 统一参数 schema、处理器注册、内部生命周期钩子（仍只允许扩展内静态代码） |
| PA10 | 上下文分层 | — | 系统规则/用户指令/站点知识/技能分层；llms.txt 仅作可选不可信资料 |
| PA11 | 内容过滤 | 标准敏感 autocomplete 字段排除 | 受信任过滤配置与预览、数据最小化；不开放任意 JS 回调 |
| PA12 | 模型适配 | 严格文本响应解析与稳定错误码；原生 function calling 与严格 JSON 双路径（auto/native/json，同一白名单与 `agentPlan` 校验，回退轮不执行动作） | 主流服务商 tool_calls 兼容性的真实验收 |
| PA13 | 诊断与历史 | 请求/工具耗时；当前任务统计导出 | 统一执行事件、脱敏轨迹导出、历史检索与跨重启续接（恢复先观察不重放） |
| PA14 | SDK / 控制器复用 | — | 后期评估；不把密钥给网页，不引入必需构建或第二套循环 |
| PA15 | 扩展任务 API | — | 有明确需求才做；默认关闭，校验来源、重放与撤销，网页不能读配置/记忆/检查点 |
| PA16 | MCP | — | 独立可选组件；基础扩展不依赖 Node 或守护进程 |

Shadow DOM、iframe、截图/视觉、文件上传、复杂编辑器单独评估，不以“吸收”名义宣称。双层记忆、技能、跨会话恢复按本项目 / Hermes 方向设计，不从上游 memory/reflection 字段推断。

## 上游参考

- [README](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/README.md)、[LICENSE](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/LICENSE)
- [DOM 简化](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/page-controller/src/dom/index.ts)、[PageController](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/page-controller/src/PageController.ts)、[actions](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/page-controller/src/actions.ts)、[React 兼容](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/page-controller/src/patches/react.ts)、[Ant Design](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/page-controller/src/patches/antd.ts)
- [配置/hooks/reflection 类型](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/core/src/types.ts)、[工具](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/core/src/tools/index.ts)
- [多页 Agent](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/extension/src/agent/MultiPageAgent.ts)、[标签页工具](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/extension/src/agent/tabTools.ts)
- [模型协议](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/llms/src/types.ts)、[会话导出](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/extension/src/lib/history-export.ts)
- [扩展 API](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/extension/docs/extension_api.md)、[MCP](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/mcp/README.md)
