# 网页工具协议

后台 `browser-tools.js` 封装 tab、inject、observe、execute、verify。内容脚本只接受受信任后台消息，不创建模型请求或任务 UI。

## observe

`agent:observe` 返回 `{documentId, snapshotId, url, page}`。page 包含标题、滚动位置、截断标记、正文和交互列表。最多 16000 字符正文、120 个元素，每个 select 最多 40 个选项。元素使用当前快照的临时 t0 等 ID；DOM 引用只存在内容脚本。

另有最多 40 个 regions（临时 r0 等 ID），总文本预算 5000 字符，单区域最多 1000。区域提供 role、名称、文本与截断标志，可用于指定范围的反馈核对。coverage 分别说明元素、区域及正文是否完整；隐藏区未读取时，不把目标未出现当成不存在。

page.groups 提供可识别的 fieldset、radiogroup、题目容器及原生选项组上下文，各元素带 group、name、label、checked。优先读取原生/嵌套 label 并去重。组上下文总长限 5000 字符，无法确定归属时模型应询问，不保证任意网站题型都能识别。

交互列表除原生控件外，还包含 role=link/menuitem/switch、onclick、非负 tabindex 及 pointer 鼠标样式边界的自定义控件。pointer 继承的子图标与计数不重复分配 ID；有显式控件祖先或后代的 pointer 容器不作为额外目标。标签支持 aria-labelledby 和 title，不根据站点类名或计数推断业务含义。没有可识别线索、超出 120 项或不在顶层 DOM 的按钮仍可能遗漏。onclick 仅用于识别，扩展不读取执行其代码，点击遵守现有确认设置；执行前滚入视野和命中检查，再派发常用 pointer/mouse/focus 事件，最后一次 click。合成事件不是受信任的真实鼠标事件。

## execute

`agent:execute` 携带 `{operationId, documentId, snapshotId, url, plan, expected}`。URL 与快照须仍匹配；执行消费快照，不能重复调用。后台校验 plan，内容脚本再次检查目标、字段类型及签名。

| action | 参数 | 行为 |
|---|---|---|
| done | reply | 后台结束，不调用 DOM |
| pause | reply | 尚未完成且受阻，保留任务并暂停，不冒充完成 |
| observe | reply | 刷新观察，不修改页面 |
| verify | expected | 立即只读验证条件，不匹配反馈给模型 |
| wait | expected、可选 timeoutMs | 等待条件，默认 10 秒，最多 30 秒 |
| click | id | 滚入视野、检查遮挡、派发事件序列和一次 click；直接自动执行 |
| fill | id、字符串 value | 支持的 input / textarea，派发 input/change |
| check | id、布尔 value | 原生 radio / checkbox |
| select | id、字符串 value | 存在且未禁用的 option |
| scroll | up / down / left / right 的 value，可选 id | 按方向滚动 600px；id 指定当前快照中的容器，不传则滚动窗口 |

不执行代码、HTML、URL 指令或任意选择器。密码、文件、隐藏字段、扩展 UI 被排除；普通表单可能含隐私，不能承诺全面脱敏。

## 等待和结果

动作后进行最多约 600ms 的短暂稳定性观察，随后按 expected 检查；未满足时保存检查点，在后续 tick 继续只读验证，不重复执行动作。默认等待 10 秒，最多 30 秒，浏览器调度可能延迟。无 expected 的点击仅报告变化或未知，不能认定业务成功。

操作回执丢失后先检查标签页：加载中或 URL 已变则等待新页；同页则只重连读取，必要时补注入，不重复执行动作。已重连和文档切换有独立 connection 状态，不能把旧断线当作当前仍无法连接。网页明确返回的工具错误不会被当成导航；PAGE_BUSY 等待上个操作结束再观察。

fill/check/select 自动添加实际 value/checked 相符条件。字段节点替换时，用名称、role、所属组等进行唯一匹配后核对，不自动补写；找不到、匹配多项或范围截断则未知。未在期限内核实才暂停。旧 verification 字段暂保留兼容，运行器以 V2 结果为准。

## V2 结果与条件

工具返回 version、operationId、documentId、status、dispatch、scope、code、observed、evidence、recovery、message。status 为 success/not_satisfied/pending/unknown/unsupported/error；dispatch 为 not_sent/sent/unknown。success 只对应本次工具预期，scope 标注 dispatch/ui/page，不能直接推导服务端成功或整个任务完成。

code 为稳定机器代码，控制流不依赖中文 message。旧 navigation/connection/verification 由 tool-protocol.js 适配；回执丢失一律 unknown，恢复后也不假装原动作已成功。

expected 为 1–5 个 AND 条件，每项 `{kind, id, value?}`，或 `{kind, target, value?}`。target 为受限语义目标 `{category: 'element'|'region', label, role?, name?, group?}`，不接受选择器/脚本。支持 field_equals、checked_equals、element_visible、element_absent、text_present、url_changed、url_equals。text_present 必须指向具体可读取区域；URL 比较仍受同源限制。

示例：`{"action":"click","id":"t2","reply":"保存","expected":[{"kind":"text_present","id":"r0","value":"保存成功"}]}`。运行器会保存语义目标、原文档和 deadline，区域中的新反馈才可满足条件，其他位置的同名提示不算证据。

memory_read/write/delete/clear 在后台执行，不送到网页；占用普通模型轮数，不经过点击确认。记忆协议见 [上下文](context-and-skills.md)。

过期目标返回 STALE；加载阶段可返回 NAVIGATION。无法注入时说明需要点击扩展图标或重新授权。只支持当前可访问的同源页面。

后续：局部读取、批量操作、更复杂的语义断言、截图、iframe 和 Shadow DOM；当前有限条件不等于能理解所有网站的成功含义。

## 弹窗与核对证据

顶层 DOM 中原生 open dialog、role=dialog/alertdialog 和 aria-modal=true 区域的控件、区域优先抽取，仍遵守 120 控件、40 区域及文字预算；不支持浏览器原生 confirm/alert 弹窗。弹窗分组优先于内部 form，支持 aria-labelledby，背景无分组不等于匹配任意弹窗分组。element_visible/element_absent 的预期分别显示 true/false，侧栏显示目标与证据 code；unknown 的实际值仍可能为 null，不伪造观测。


## 视口覆盖、滚动与点击兼容

弹窗仍优先；同一优先级内，控件和区域按是否与当前视口相交排序，考虑 overflow 祖先的裁剪。`inViewport` 仅代表几何相交，不保证没有遮挡。120 控件、40 区域及原有正文预算不变；滚动后重新读取，可将先前被预算截断的后续控件纳入快照。全文分区分页尚未实现，`coverage` 不完整时仍不能证明不存在。

`page.viewport` 包含 width/height 和 x/y/maxX/maxY。可滚动容器作为当前目标提供 `scroll: {x,y,maxX,maxY}`。scroll 只接受当前快照 ID，检查节点签名和状态；不接收选择器，不自动改为滚动其他容器。回执 observed 包含 axis/before/after/delta/atStart/atEnd，边界不等于任务完成。RTL 负向 scrollLeft 暂无专门适配。

额外读取 role=combobox/option/tab，以及 expanded、selected、haspopup 和受控浮层的名称 controlledLabels；不执行控件脚本，也不保证任意组件可用。展开或选中状态变化使旧目标签名失效。

点击初始命中不属于当前目标时返回 TARGET_BLOCKED、dispatch=not_sent，最多两次重新观察规划。hover/down/focus/up 已发出后，目标被替换或遮挡则返回 TARGET_CHANGED、dispatch=unknown 并暂停，不继续 click。事件处理器可能已有副作用，因此不能宣称撤销或自动重放。只支持命中点检查，复杂形状、受信任事件及富文本仍有局限。

## 虚拟鼠标与悬停（已实现）

`hover` 与 `click` 一样使用当前快照 `id`，拒绝失效、隐藏、禁用或被遮挡的目标，不接受坐标、选择器或脚本。派发 pointer/mouse over、enter、move，不派发 down/up/click；结果仍须按新快照和 expected 核对。合成事件不能设置真实 CSS 悬停状态，也不提供 isTrusted 输入。

`page-pointer.js` 在 isolated world 管理独立、禁止命中的显示层（内部样式使用封闭 shadow root 隔离，这不代表支持操作网页 Shadow DOM）。core 校验目标后触发视觉反馈；动画不阻塞操作，不新增模型请求。显示层排除在抽取和隐藏覆盖判断之外。约 900 毫秒自动隐藏；后台停止、手动结束或运行器进入非活动状态时发送仅可信后台可用的 `agent:clear-pointer`。pagehide、滚动、resize、visibilitychange 清理当前显示层。不新增权限或依赖；不保存指针状态。

视觉反馈本身不消耗模型 token；新增 hover 的稳定说明、动作记录和重新观察可能增加用量。纯 CSS 悬停、拖拽、右键、双击及系统鼠标控制未实现。
