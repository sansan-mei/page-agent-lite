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
| wait | expected、可选 timeoutMs；或仅 timeoutMs | 有 expected 时等待条件（默认 10 秒，最多 30 秒）；无 expected 时纯延时，必须提供 100–30000 毫秒时长 |
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

expected 为 1–5 个 AND 条件，每项 `{kind, id, value?}`，或 `{kind, target, value?}`。target 为受限语义目标 `{category: 'element'|'region', label, role?, name?, group?}`，不接受选择器/脚本。支持 field_equals、checked_equals、selected_equals、expanded_equals、element_visible、element_absent、text_present、url_changed、url_equals。text_present 必须指向具体可读取区域；URL 比较仍受同源限制。

示例：`{"action":"click","id":"t2","reply":"保存","expected":[{"kind":"text_present","id":"r0","value":"保存成功"}]}`。运行器会保存语义目标、原文档和 deadline，区域中的新反馈才可满足条件，其他位置的同名提示不算证据。

memory_read/write/delete/clear 在后台执行，不送到网页；占用普通模型轮数，不经过点击确认。记忆协议见 [上下文](context-and-skills.md)。

过期目标返回 STALE；加载阶段可返回 NAVIGATION。无法注入时说明需要点击扩展图标或重新授权。只支持当前可访问的同源页面。

后续：单区域正文分段、批量操作、更复杂的语义断言、截图、iframe 和 Shadow DOM；当前有限条件不等于能理解所有网站的成功含义。

## 弹窗与核对证据

顶层 DOM 中原生 open dialog、role=dialog/alertdialog 和 aria-modal=true 区域的控件、区域优先抽取，仍遵守 120 控件、40 区域及文字预算；不支持浏览器原生 confirm/alert 弹窗。弹窗分组优先于内部 form，支持 aria-labelledby，背景无分组不等于匹配任意弹窗分组。element_visible/element_absent 的预期分别显示 true/false，侧栏显示目标与证据 code；unknown 的实际值仍可能为 null，不伪造观测。


## 视口覆盖、滚动与点击兼容

弹窗仍优先；同一优先级内，控件和区域按是否与当前视口相交排序，考虑 overflow 祖先的裁剪。`inViewport` 仅代表几何相交，不保证没有遮挡。120 控件、40 区域及原有正文预算不变；滚动后重新读取，可将先前被预算截断的后续控件纳入快照。正文分段及控件分页/查找见下文，区域分页/名称查找见下文，`coverage` 不完整时仍不能证明不存在。

`page.viewport` 包含 width/height 和 x/y/maxX/maxY。可滚动容器作为当前目标提供 `scroll: {x,y,maxX,maxY}`。scroll 只接受当前快照 ID，检查节点签名和状态；不接收选择器，不自动改为滚动其他容器。回执 observed 包含 axis/before/after/delta/atStart/atEnd，边界不等于任务完成。RTL 负向 scrollLeft 暂无专门适配。

额外读取 role=combobox/option/tab，以及 expanded、selected、haspopup 和受控浮层的名称 controlledLabels；不执行控件脚本，也不保证任意组件可用。展开或选中状态变化使旧目标签名失效。

点击初始命中不属于当前目标时返回 TARGET_BLOCKED、dispatch=not_sent，最多两次重新观察规划。hover/down/focus/up 已发出后，目标被替换或遮挡则返回 TARGET_CHANGED、dispatch=unknown 并暂停，不继续 click。事件处理器可能已有副作用，因此不能宣称撤销或自动重放。只支持命中点检查，复杂形状、受信任事件及富文本仍有局限。

## 虚拟鼠标与悬停（已实现）

`hover` 与 `click` 一样使用当前快照 `id`，拒绝失效、隐藏、禁用或被遮挡的目标，不接受坐标、选择器或脚本。派发 pointer/mouse over、enter、move，不派发 down/up/click；结果仍须按新快照和 expected 核对。合成事件不能设置真实 CSS 悬停状态，也不提供 isTrusted 输入。

`page-pointer.js` 在 isolated world 管理独立、禁止命中的显示层（内部样式使用封闭 shadow root 隔离，这不代表支持操作网页 Shadow DOM）。core 校验目标后触发视觉反馈；动画不阻塞操作，不新增模型请求。显示层排除在抽取和隐藏覆盖判断之外。约 900 毫秒自动隐藏；后台停止、手动结束或运行器进入非活动状态时发送仅可信后台可用的 `agent:clear-pointer`。pagehide、滚动、resize、visibilitychange 清理当前显示层。不新增权限或依赖；不保存指针状态。

视觉反馈本身不消耗模型 token；新增 hover 的稳定说明、动作记录和重新观察可能增加用量。纯 CSS 悬停、拖拽、右键、双击及系统鼠标控制未实现。

纯延时示例：`{"reply":"等待15秒后继续","action":"wait","timeoutMs":15000}`。后台只检查持久化的 deadline，不轮询网页条件或请求模型；到期记录 `DELAY_ELAPSED`，随后重新读取页面再规划。该成功只代表时间已过，不证明视频切换或其他网页操作成功。重复间隔还受模型和浏览器调度耗时影响。

## 正文分段读取（PA1 首个增量）

模型可返回 `{"reply":"读取后续正文","action":"observe","value":16000}`；value 为非负安全整数，表示当前规范化正文的 UTF-16 字符偏移。后台 observe(tabId, textOffset) 转发为 agent:observe.textOffset，返回 page.textRange 的 start/end/total/nextOffset（末段为 null），每段最多 16000 字符，超出末尾返回空段。范围指当前 DOM 文本，不是稳定分页游标；内容变化应从 0 重读。后续段仍标记 textComplete=false，不能据此证明全文不存在某项。正文片段作为不可信工具结果进入下一轮，停止/代次变化丢弃迟到结果，导航或文档变化丢弃本次读取；下一轮仍重新观察后规划动作，不复用分段快照目标。不会滚动或分页控件/区域。

## 控件分页与片段查找（PA1）

`observe` 的 value 也可为 `{elementOffset:120}`、`{query:"保存",elementOffset:0}` 或仅 query。只允许这两个字段；偏移为非负安全整数，query 为非空、最多 180 字符的纯文字。匹配可访问标签或 name 的不区分大小写字面子串，不解释 CSS、正则或代码，不自动选择首个匹配。只搜索已支持的顶层、可见控件；禁用控件可读取但不能执行，敏感字段仍排除。

`page.elementRange` 提供 start/end/total/nextOffset/query；total 是当前筛选下的匹配数，末页 nextOffset=null。按弹窗/视口优先顺序分页，每批 120 项；滚动、展开或 DOM 变化可能改变顺序，不能将偏移当稳定游标。筛选或非零偏移始终 elementsComplete=false，查无结果不是不存在证明；该请求不滚动页面。区域列表仍有原有预算。

后台保存一次性的 nextObservation，下一 tick 重新捕获该范围并让模型使用当前快照 ID；不从旧结果列表直接点击。URL/documentId 改变则丢弃范围、重新默认观察。停止、补充指令、恢复及记忆管理造成代次变化时清空范围。内容脚本仍按 snapshotId/documentId/URL 和签名校验，快照仅能执行一次。旧整数 value 的正文读取协议不变；传输沿用 agent:observe.textOffset，接受整数或上述对象。

## 原生字段事件兼容（PA2 增量）

fill 仍只接受现有 input 类型及 textarea。使用原型 value setter 绕过实例 value 跟踪器，不注入主世界补丁。先以同类型脱离文档的 input 检查浏览器值清洗；若指定值不能原样保留，返回 INVALID_FIELD_VALUE、dispatch=not_sent，不修改原字段。该检查不验证 min/max、pattern 或业务保存，空字符串仍可清空。

聚焦后重核对节点签名，再派发可取消 beforeinput；支持 InputEvent 时携带 data、inputType=insertReplacementText、isComposing=false 和 composed=true。网页 preventDefault 返回 INPUT_CANCELLED，不继续 setter/input/change；因处理器可能已有副作用，dispatch=unknown，不冒称撤销或自动重试。允许输入后使用原生 setter，再派发 input/change；select 保留普通 input/change。聚焦/事件处理器替换、隐藏、禁用节点或修改字段类型时返回 TARGET_CHANGED 并停止后续事件。InputEvent 不可用时降级普通 Event。

现有稳定观察及字段 expected 仍核对实际值：异步回滚为 not_satisfied，替换后只能唯一语义匹配核对；不自动补写。控制器可能要求 isTrusted/键盘/IME 或特定框架协议，本增量不保证兼容，不支持组合输入、复杂富文本或任意脚本。

## ARIA 选择控件与状态核对

listbox 内控件优先按 listbox 分组（包括位于 dialog 内或独立挂载的弹层）；名称先用自身 aria-label/aria-labelledby/标题，再用唯一可见 combobox 的名称。通过 aria-controls/aria-owns 的 DOM ID 引用关联，不执行选择器；多 owner 时不任取一个，不以选项文字冒充控件名称。listbox 也作为可读 region，仍受原预算限制。弹层节点或归属关联改变使旧目标签名失效。

selected_equals 和 expanded_equals 接收布尔 value，分别只读核对明确的 aria-selected/aria-expanded；缺失或非 true/false 状态为 unknown，不能默认为 false。这两个条件沿用 expected、wait、verify、done 及证据展示，不新增选择器专用动作。先 click 打开，再按新快照分组挑选选项；选项 click 后派发不等于选中成功。选项消失/隐藏后不能核实 selected_equals，应核对 combobox 值或指定结果区域。不推断键盘焦点等于选中，不派发可信键盘事件。

## 目标滚轮输入

`wheel` 必须提供当前快照元素 id 和 up/down/left/right 的 value。检查签名、状态和遮挡，向命中子元素派发一次冒泡、可取消的 WheelEvent（像素模式，指定轴 ±600），不接收坐标/选择器，不自动回退其他容器。observed.input=wheel、deltaX/deltaY 是输入量，defaultPrevented 只是监听器取消标志，不是实际位移或成功证据。合成 wheel 只触发监听器，没有原生默认滚动或 isTrusted；普通 scroll 不变。窗口不动时可据当前页面尝试 wheel，但必须核对可识别的内容变化，播放计时变化不能证明切换。

只读 verify 自身的 dispatch=not_sent 不得覆盖原动作派发状态；运行器核对回执沿用 action 检查点的 sent/unknown，旧检查点缺失时为 unknown。

## 区域分页与按需核对

observe 的对象 value 可加 regionOffset（非负安全整数）、regionQuery（非空纯文字，最多 180 字符），可与控件范围字段合用。regionQuery 仅匹配区域名称的不区分大小写字面子串，不搜索正文、不解释选择器或正则。`page.regionRange` 返回 start/end/total/nextOffset/query；范围计数在当前匹配集上，排序沿用弹窗/视口优先。仍限 40 项、总文字 5000、每区域 1000；因此跟随 nextOffset 而非固定加 40。超出末尾返回空列表；筛选/非零偏移 regionsComplete=false。

下一轮使用已有 nextObservation 重新捕获范围，不持久化区域 ID，不增加模型预算或权限。按区域分页不会滚动网页；DOM 变化可能改变顺序。单个区域 textTruncated 仍保留，未提供其内部文字分页。

verify 和动作后核对会针对绑定条件中具名 region 进行额外只读名称查找，最多随 5 个条件读取并按节点 key 去重；不发送额外模型请求、不执行网页动作、不改变当前动作快照。语义匹配仍需唯一，重复名称保持 ambiguous。合并不提升原覆盖完整性：原全页读取不完整时，找不到目标仍是 unknown；原范围确已完整时保留既有缺失核对语义。额外读取不证明全文完整或服务器成功。

## 简单 contenteditable（PA3）

显式 contenteditable=true、空值或 plaintext-only 根节点可作为 textbox，快照 editable=plain_text 并提供 value。仅允许文本节点与无属性 br（读取为换行）；出现其他节点、注释、格式或嵌套控件时 editable=unsupported_structure，不提供 value。未命名编辑区不以正文冒充标签，保持节点身份核对。

fill 仅将指定字符串写入 textContent（最多 4000 字符），不解析 HTML，不调用 execCommand 或框架命令。先检查结构，再聚焦、可取消 beforeinput、重新校验节点/签名，然后写入并派发 input/change；已有取消、隐藏、禁用、只读和节点替换保护适用。复杂结构在聚焦/输入事件前返回 UNSUPPORTED_EDITABLE、status=unsupported、dispatch=not_sent，运行器暂停，不删除原节点。

自动 field_equals 与短暂观察核对实际纯文本，异步回滚为 not_satisfied；后续变成复杂结构则无可读取值，保持 unknown。仅证明本地内容，不证明服务端或框架保存；继承可编辑根、复杂 DOM 编辑器、富文本格式、IME/受信任键盘及撤销栈未支持。

## 精简鼠标与键盘输入

press_key 必须指定当前元素 id，value 为按键或组合键（例如 ArrowDown、Escape、Control+a、Shift+Tab）。修饰键仅 Control/Alt/Shift/Meta，不可重复；主键仅 Enter/Escape/Tab/Space/ArrowUp/ArrowDown/ArrowLeft/ArrowRight/Home/End/PageUp/PageDown/Backspace/Delete 或小写 a-z。先检查遮挡、聚焦目标，派发 keydown/keyup；目标、焦点或遮挡改变即停止后续事件。没有跨动作按住状态，不补发浏览器原生编辑/默认行为，文本使用 fill。

double_click 向当前 id 执行两次受保护 click 后派发 detail=2 的 dblclick；中间变化立即中断，前一次点击可能已生效。right_click 派发右键 pointer/mouse down/up 和 contextmenu，不打开浏览器原生菜单。事件回执仍是 sent/unknown，需独立核对；不新增权限、坐标或选择器输入。拖拽、长按及 OS 输入不在本版范围内。

## 控件语义上下文

元素 context.path 提供由外向内最多三层具名 section/article/main/fieldset/form/dialog 或 ARIA region/group/dialog；名称使用 aria-label、可读取 aria-labelledby 或属于本区域的首个可见标题，不挪用嵌套区域标题。context.description 读取最多五个去重 aria-describedby 引用，最多 300 字符。单层路径名称最多 160 字符，每快照路径及说明合计 4000 字符，预算不足裁短或省略；单个说明节点最多扫描 300 节点。

新增文字只取可见普通文本，排除 hidden/aria-hidden、CSS display:none/visibility:hidden、关闭 dialog、扩展 UI、脚本/样式、原生输入和 contenteditable 子树。不宣称全面隐私识别。上下文仅为不可信定位线索，不参与自动重放、动作授权或条件匹配；相同名称仍需模型使用当前 ID 消歧，验证仍要求受限语义目标唯一。不增加动作、权限或请求。

用户接管通过侧栏可信后台消息完成，不新增模型动作。接管只取消尚未生效的旧计划与请求，已派发动作可能继续由网页处理；返回继续后使用新快照，未确定目标仍不能重复执行。

## 按需省略整页正文（PA5）

observe 对象 value 支持 includeText 布尔值，可独立使用或与控件/区域范围结合。默认或 true 保留整页正文；false 跳过 body 克隆/正文提取，page.text 为空，textRange={start:0,end:0,total:null,nextOffset:null,omitted:true}，coverage.textComplete=false 且 truncated=true。total=null/omitted 表示没有读取正文，不表示内容为空或读到末尾；普通 observe 或整数偏移可重新读取正文。控件、区域、标签和语义说明仍按原预算提供，不能承诺所有页面文字都省略。

对象读取沿用 nextObservation：下一 tick 新快照使用此范围，后续普通读取恢复默认；不增加请求或修改动作/条件语义。省略正文不省略区域抽取的扫描与克隆，未实现 DOM 增量快照或低影响批量操作。

响应可选 subgoals 描述公开任务里程碑，不是网页工具：后台核对其中 completed.checks 后保存历史进度，不触发 DOM 执行。checks 沿用 expected 的有限条件，副作用和任务最终完成仍走原有协议；详情见运行器文档。

## 可信同源导航（PA7 基础）

navigate 使用绝对 HTTP/HTTPS 字符串 value（最多 2000 字符），不接受元素 id、凭据、脚本或内部协议。运行器自动绑定 url_equals 到规范化目标 URL；目标须与当前任务 origin 相同，沿用现有站点边界。只应使用用户给定或当前页面有依据的目标，不通过猜测业务动作 URL 绕过控件流程。

浏览器适配层检查源/目标同 origin、当前主机权限与当前标签页 URL，再调用仅可信后台可用的 agent:prepare-navigation：内容脚本校验 documentId/snapshotId/URL 并消费快照，不修改网页。随后后台仅调用一次 tabs.update；内容脚本拒绝直接执行 navigate。tabs.update 正常回执为 NAVIGATION_DISPATCHED、dispatch=sent，但 status=unknown，仍需核对目标；回执失败为 NAVIGATION_UNKNOWN、dispatch=unknown，只读等待 URL，不自动补发。权限缺失、来源变化和非法目标在派发前拒绝。

导航使用既有 executing/action 检查点和原等待 deadline，worker 重建后仅验证；任务 ID/轮数不重置。跳转或重定向越过原 origin 会被既有站点边界暂停，不读取跨站页面；不支持指定额外标签页、跨站任务授权集合或任意 URL 执行脚本。
