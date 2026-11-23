# 架构与数据流

这是当前实现说明。目标是轻量浏览器 Agent，借鉴 Hermes 的运行器、工具、会话和上下文职责分离，不依赖 Hermes 进程。

实施方案见 [通用网页 Agent V1 实施规划](general-agent-v1.md)。V2 结果协议、有限条件检查和可恢复等待已实现；M4/PA1 已实现正文按偏移分段读取；控件及区域已支持偏移分页和名称片段查找，批量操作尚未实现。页面工具已补充视口优先抽取、容器四向滚动和受限点击事件兼容，仍保留预算与截断语义。

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
| `welcome-image.js` | 设置页与侧栏共用的主图上传、解码/缩放、local 偏好与预览同步；不读取模型配置或任务目标 |
| `background.js` | 可信来源验证、组装依赖、事件唤醒与 alarm 调度 |
| `runtime.js` | 每次 tick 推进一步、预算、状态、重试、停止和恢复 |
| `tool-protocol.js` | V2 工具结果、稳定代码、旧返回适配，分开派发与证据 |
| `conditions.js` | 条件校验、语义目标绑定、唯一匹配的只读核对 |
| `site-memory.js` | IndexedDB 网站/全局双作用域笔记、原子版本更新与取消；只有后台调用 |
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

## 后续能力吸收（未实现）

[Page Agent 能力吸收计划](page-agent-integration-plan.md) 记录 DOM/控件兼容、任务与标签页、工具/hooks、模型协议及可选外部集成的来源与适配边界。当前模块和信任边界保持现状，后期可选 MCP 评估不代表当前依赖 MCP。

## 取舍

不引入服务端、Python、向量库、MCP 或子 Agent。保留非流式 OpenAI 兼容接口和严格 JSON 工具协议。近期顺序见 [Roadmap](../ROADMAP.md)，网站与全局长期笔记已接入，技能和跨会话任务恢复尚未实现。

参考：[Hermes 架构](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)、[Agent 循环](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)、[Chrome worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)。不代表项目具备 Hermes 全部能力。

页面内操作反馈由 `page-pointer.js` 管理，通过浏览器适配层随 core/content 注入；没有任务状态或模型访问。core 同步触发显示，动画与实际操作并行；后台运行器在停止/结束/非活动状态清理显示层。hover 复用当前快照目标校验、工具回执及观察核对流程。

原生字段兼容逻辑保留在 core.js：原型 setter、受限合成输入事件与事件间目标检查。content.js 执行后的短观察及 conditions.js 值核对保持职责；runtime.js 依稳定输入 code 暂停，不在 DOM 层保存任务或运行循环。

ARIA listbox/combobox 归属由 core.js 抽取为语义分组并纳入目标签名；conditions.js 统一只读核对 selected_equals/expanded_equals。运行器继续使用通用 click/wait/verify，没有组件库专用动作或第二条执行循环。

content.js 的条件读取可按具名 region 额外只读捕获并合并，conditions.js 仍独立执行唯一语义匹配；不新增执行循环或模型请求。

简单 contenteditable 由 core.js 判定可替换结构并复用 fill 事件路径；conditions.js 通过快照 value 核对，无新工具动作或执行循环。复杂结构在 DOM 写入前拒绝，runtime.js 按 UNSUPPORTED_EDITABLE 暂停。

core.js 的控件 context 是受预算限制的只读语义线索（具名祖先路径与 aria-describedby），prompts.js 提醒其不可信且可能省略；条件唯一性与运行器生命周期保持既有职责。

PA4 用户接管由侧栏发送可信 task:takeover，background.js 路由至 runtime.js；取消、代次隔离、暂停和未确定动作防重放仍集中于运行器。页面工具不保存接管目标或任务状态。

PA5 的 includeText=false 由 core.js 跳过整页 body 克隆与提取，仍生成当前控件/区域快照；运行器复用一次性 nextObservation，无新循环或模型调用。

PA6 子目标由 core.js 校验响应结构，runtime.js 在现有模型轮次内核对/更新 session taskPlan，prompts.js 注入历史进度，sidepanel.js 以安全文本显示。没有独立计划执行器、隐藏思维记录或额外规划请求。

同源 navigate 由 runtime.js 记录检查点，browser-tools.js 校验权限/URL 并请求 content.js 消费快照后仅一次 tabs.update；内容脚本不直接导航、不保存目标。conditions.js 自动生成 URL 目标核对，仍是单标签单 origin 运行器。

## 静态可信工具策略（PA9 基础）

core.js 内部持有冻结的 agentToolRegistry，每项只含 route（runtime/content/browser）、effect（read/control/page/storage）、target（none/required/optional）、timeout 和 guard。agentTool/agentToolNames 只读查询，拒绝未知及对象原型名称，不暴露注册/回调入口；工具只能由受信任源码修改。

agentPlan 的动作、必需目标与 timeout 白名单，prompts.js 的动作目录及 runtime.js 的未确定目标防重放读取同一策略。agentExecute 明确拒绝运行器/浏览器专属动作，done 保留既有空操作兼容。类型/值及条件的专门校验仍在现有模块，V2 结果协议不变。尚未统一全部参数 schema、处理器注册或生命周期 hooks，不等于模型能扩展工具。

PA11 标准敏感字段策略固定于 core.js，抽取正文/控件/引用文字共用排除集合，执行与字段核对再次检查目标。没有模型可配置过滤代码、额外权限或后台/网页密钥交换。

PA13 初步计时集中在 runtime.js 的请求/工具调用边界，sidepanel.js 只读显示 session metrics；不注入页面时钟、遥测或第二套执行循环，也不把正常回报次数当作工具业务成功次数。

PA13 统计导出由可信 background.js 路由至 runtime.diagnostics，按固定字段重建报告；侧栏只负责下载 JSON。无内容脚本入口、额外下载权限或模型访问，不遍历/导出原始任务对象。

PA12 backend.js 的 parseChatResponse 统一解析非流式兼容文本与 usage；仅通过的字符串交给既有严格 JSON 动作/摘要校验器。结束状态不支持、截断或拒绝不做修补/回退，后台不回显服务响应正文。没有引入原生 function calling 执行路径。

PA7/PA8 下一步实施依据为 [任务站点集合与标签归属设计](task-scope-v3.md)（未实现）。设计覆盖 root/registry 双记录一致性、任务级调度、显式站点/成员授权及只读恢复；当前架构仍是单标签单 origin，不因设计新增可调用工具或权限。

PA7/PA8 存储第一步已实现：task-store.js 以 taskRoot:taskId + taskRegistry 单成员归属解析旧 tabId API，task:tabId 仅为旧版迁移输入，侧栏监听根/索引变化后经后台刷新；意图中断只读对账后暂停。任务级调度已迁移（见下文），尚未开放多成员或跨 origin 授权。

任务运行资源已从 tabId 身份迁至 taskId：runtime 的 jobs/请求控制器/运行锁与后台 timers、task-id:taskId alarm；tab 发布队列及 API 仍作为替换/兼容边界。store.getByTaskId 仅解析已提交的当前归属。新调度携带 expectedTaskId，旧任务唤醒不能操作同标签新任务；旧 task:tabId alarm 清理并通过当前归属升级调度。

成员关闭由 background.js 的 tabs.onRemoved 路由 runtime.memberClosed；运行器立即取消控制器，在标签发布/任务锁内取消调度并调用 store.closeMember，存储层用关闭意图完成终态归档和归属释放。不会复用 runtime.remove 或删除历史。恢复先由 browser-tools.existingTabIds 提供只含 ID 的可信清单，缺失成员走同一路径，清单查询失败则不做关闭推断；目录不发送给模型，不引入新工具动作或权限。当前只支持最后一个成员关闭，多成员暂停/移除策略仍待实现。

任务范围面板由 sidepanel.js 用户手势申请可选主机权限，再发 task:scope-change；background.js 只允许顶层侧栏来源并筛选参数，runtime.js 校验任务/范围版本与主机权限，task-store.js 专用 changeOrigins 发布范围版本。普通检查点 set 保留权威授权集合及初始成员，模型无范围修改工具。运行器在观察/派发前门禁，浏览器撤销事件触发权限复核。此阶段新增的是授权管理与撤销，跨 origin 导航和内容分区仍未实现。
