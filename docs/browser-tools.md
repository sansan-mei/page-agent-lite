# 网页工具协议

`browser-tools.js`（后台）封装 tab、inject、observe、execute、verify、导航；`content.js` 只接受后台消息，不发模型请求。动作集合由 `core.js` 的冻结注册表 `agentToolRegistry` 定义，校验器、提示目录和运行器防重放共用同一份。

## 动作

模型每轮给出一个动作：原生工具调用（工具名即 action，参数为其余字段）或严格 JSON，如 `{"action":"click","id":"t2","reply":"保存","expected":[...]}`；两者都转成同一 plan 由 `agentPlan` 校验，见 [模型响应](context-and-skills.md#模型响应)。

| action | 参数 | 路由 | 说明 |
|---|---|---|---|
| done / pause | reply | runtime | 完成 / 受阻暂停 |
| observe | 可选 value（见下） | runtime | 只读刷新快照 |
| verify | expected | runtime | 立即只读核对 |
| view_image | id=`viewport`、当前快照元素/区域 ID 或附图 `imageN`；可选 value=问题（≤ 300 字符） | runtime | 看截图或再问附图，见 [截图](#截图) |
| wait | expected + 可选 timeoutMs；或仅 timeoutMs | runtime | 条件等待（默认 10s，最多 30s）；仅 timeoutMs 为纯延时（100–30000ms） |
| history_read | id、value=offset | runtime | 读当前来源的压缩归档，每次 4000 字符 |
| site_memory_* / global_memory_* | read/write/delete/clear | runtime | 网站与全局长期记忆，见 [上下文](context-and-skills.md) |
| read_references | value=2–8 个 `{action:site_memory_read/global_memory_read/skill_read, id}`，不重复，无 id/expected | runtime | 只读批量参考资料；沿用单条读取与来源分区，逐项返回错误，停止或代次变化不再读后续项 |
| click_point | value=`{x,y}`（最新视口截图像素），可选 expected；只对能看图的模型提供 | browser | 按截图坐标真实点击一次，见 [坐标点击](#坐标点击) |
| click | id，可选 `trusted` | content | 滚入视野、命中检查、pointer/mouse/focus 序列后一次 click；到不了或 `trusted:true` 时用[真实输入](#真实输入) |
| fill | id、字符串 value | content | input / textarea / 简单 contenteditable |
| check | id、布尔 value | content | 原生 radio / checkbox |
| select | id、字符串 value | content | 存在且未禁用的 option |
| hover | id，可选 `trusted` | content | pointer/mouse over/enter/move，无 down/up/click；到不了或 `trusted:true` 时用真实鼠标移动 |
| scroll | value=up/down/left/right，可选容器 id | content | 600px；不传 id 滚窗口 |
| wheel | id、value=方向 | content | 一次可取消 WheelEvent（±600 像素），只触发监听器，无原生滚动 |
| press_key | id、value | content | keydown/keyup，见下 |
| double_click | id | content | 两次受保护 click 后派发 detail=2 的 dblclick |
| right_click | id | content | 右键 pointer/mouse down/up + contextmenu，不打开原生菜单 |
| fill_fields | value=2–8 个 `{action:fill/check/select, id, value}`，目标不重复，无 id/expected | runtime | 一轮里按顺序写多个字段，逐项走 fill/check/select 原路径，见 [运行器](agent-runtime.md#批量填写) |
| navigate | 绝对 HTTP/HTTPS URL（≤ 2000 字符） | browser | 见 [导航](#导航) |
| tab_switch | id=tabRef | runtime | 切换执行标签页，见 [任务标签页](#任务标签页) |
| tab_open | 绝对 HTTP/HTTPS URL，无 id/expected | browser | 后台打开并登记为任务标签页，切换执行目标 |
| tab_close | id=tabRef | browser | 关闭非执行中的任务创建标签页 |

- content 路由的动作（hover、scroll 除外）都有防重放保护；目标必须是当前快照 ID。除 `click_point` 外不接受坐标；不接受选择器、脚本或 HTML。
- press_key：修饰键 Control/Alt/Shift/Meta（不可重复）；主键 Enter/Escape/Tab/Space/方向键/Home/End/PageUp/PageDown/Backspace/Delete 或小写 a–z。不保持按下状态，不触发浏览器原生编辑/快捷键；文本用 fill。
- 合成事件都不是 `isTrusted` 输入；只有 click/hover 有[真实输入](#真实输入)。拖拽、长按、系统输入不支持。

## observe 快照

`agent:observe` 返回 `{documentId, snapshotId, url, page}`。

| 内容 | 上限 |
|---|---|
| 正文 | 16000 字符/段 |
| 交互元素（临时 ID `t0`…） | 120 个/批；每个 select 40 个选项 |
| 区域（临时 ID `r0`…） | 40 个/批；总文字 5000，单区域 1000 |
| 分组上下文（fieldset、radiogroup、题目容器、listbox） | 5000 字符 |
| 元素语义 context（≤3 层具名祖先 + aria-describedby ≤ 300 字符） | 合计 4000 字符 |

- 排序：弹窗（open dialog、role=dialog/alertdialog、aria-modal）优先，其次与视口相交（考虑 overflow 祖先裁剪），视口外的按与视口的距离由近到远（同距离保持文档顺序）。`inViewport` 只是几何相交。
- 识别的交互元素：原生控件、role=link/menuitem/switch/combobox/option/tab、onclick、非负 tabindex、pointer 样式边界。可点击行内的子元素若自带交互线索（a、label、summary、aria-haspopup/expanded/pressed、data-testid）单独列出，如悬浮才显形的「添加/更多」。onclick 只用于识别，不读取执行。标签来自 label、aria-labelledby、title。
- 元素可带 `scroll {x,y,maxX,maxY}`、expanded/selected/haspopup、`controlledLabels`、`editable`（plain_text / unsupported_structure）、`context {path, description}`。
- `coverage` 分别标注元素、区域、正文、框架是否完整；`page.viewport` 给出窗口尺寸与滚动范围。没读到不等于不存在。
- 默认排除：密码/文件/隐藏字段、`autocomplete` 含 current-password/new-password/one-time-code/cc-number/cc-csc 的元素及子树（不区分大小写，支持 section-/billing 前缀）、hidden/aria-hidden、自身或祖先 display:none、自身计算样式 visibility:hidden/collapse（子元素可用 visible 覆盖祖先）、扩展自身 UI。opacity:0 不排除。存在敏感排除时 `coverage.sensitiveExcluded=true`。这不是全面脱敏。可信后台传入本对话的敏感字段授权时，允许密码及上述 autocomplete 字段；文件、隐藏字段始终排除。授权绑定快照，执行消息的授权不一致则拒绝旧快照。模型只能用 `request_sensitive_access` 请求侧栏确认，不能自行授权；交互见 [使用指南](usage.md#敏感字段授权)。

### iframe

顶层内容脚本从 isolated world 经 `contentDocument` 读取单层同源 iframe。后台另用 `webNavigation.getAllFrames` 识别直接跨源子框架，在对应来源具备浏览器主机权限，且属于任务范围或存在当前顶层来源到它的已记住授权关系时注入内容脚本，汇总读取并按框架路由动作。

- 跨源框架只接受唯一匹配声明 src 的直接子框架；重定向、同 URL 多框架、嵌套与 opaque 来源保持未读。框架须在视口内且通过顶层遮挡检查；未授权时 `reason=permission_required` 并提供 origin，运行器在助手因此暂停时显示侧栏框架授权卡片，由用户按来源授权并记住顶层来源到框架来源的关系；保存与撤销见[使用指南](usage.md#跨源表单)。
- 后台保存的 `frameRoutes` 不发给模型；检查点的 `frameRoute` 绑定框架 ID、来源、URL、文档与一次性快照。执行前重新检查权限、代次和顶层快照，回执丢失只读核对。跨源条件由后台汇总新快照核对；框架文档变化即不匹配旧 frame key，缺失证据保持 unknown。合并沿用控件、区域和正文预算；跨源读取不作为全局不存在的证明。敏感字段沿用本对话授权。

- 同源且已加载的 iframe（最多 10 个）节点紧跟在其 iframe 元素之后参与排序，与顶层共用控件、区域、正文和上下文上限；正文段以 `[f0 标题]` 前缀接在顶层正文后。
- `page.frames`（≤ 20 项，无 iframe 时省略）：`{id, key, label, url, read, reason, origin?}`，label 取 title/aria-label/name；未读 reason 为 `cross_origin`、`permission_required`、`blocked`、`unavailable`、`nested`、`loading`（含 src 未加载完的初始 about:blank）、`limit`。隐藏 iframe 跳过；不可读且面积 < 4px² 的 iframe 忽略。存在未读框架时 `coverage.framesComplete=false`；element_absent 的完整性不覆盖未读框架。
- 框架内元素、区域带 `frame`（`page.frames` 的 id）；节点 key 全局唯一。可见性、inViewport 按 iframe 内容框偏移并受 iframe 可见框裁剪。敏感字段与隐藏规则在框架内同样生效，iframe 本身处于敏感/隐藏子树时整框不读。
- 执行：所有 content 动作都可用于框架内目标，在框架自身文档内完成——视口、`elementFromPoint`、事件构造器和原生 value setter 都取自该框架窗口；命中探测点还要求顶层在对应坐标命中该 iframe，否则以顶层遮挡层回报 `TARGET_BLOCKED`。iframe 被移除、隐藏或换了文档 → `STALE`。同源框架的虚拟指针画在顶层；跨源框架画在自身文档中。
- 条件：语义目标的 `frame` 为 iframe key（顶层为空串），绑定后与 group 一样始终比较，顶层与框架内同名控件不会互相匹配。

### 分段读取

observe 的 value：

| value | 作用 | 返回 |
|---|---|---|
| 非负整数 | 正文从该 UTF-16 偏移读取 | `page.textRange {start,end,total,nextOffset}` |
| `{elementOffset, query}` | 控件分页；query 为 ≤ 180 字符纯文字，匹配标签或 name 子串（不区分大小写） | `page.elementRange` |
| `{regionOffset, regionQuery}` | 区域分页；regionQuery 只匹配区域名称 | `page.regionRange` |
| `{regionQuery, regionTextOffset}` | 单个区域内部文字分段（必须带 regionQuery） | `region.textRange` |
| `{includeText:false}` | 省略整页正文，仍提供控件和区域 | `textRange.omitted=true` |

- 对象字段可组合，只允许上述键。偏移基于当前 DOM，不是稳定游标；内容变化后从 0 重读。末段 `nextOffset=null`。
- 筛选或非零偏移时对应 `*Complete=false`；查无结果不是不存在证明。分段读取不滚动页面。
- 对象范围写入一次性 `nextObservation`，下一 tick 用新快照重新捕获；URL/documentId/代次变化即作废。模型只能用新快照 ID。

## execute

`agent:execute` 携带 `{operationId, documentId, snapshotId, url, plan, expected}`。URL 和快照必须匹配，快照只能执行一次；内容脚本再次检查目标、字段类型和签名。

- **命中检查**（click/hover/wheel/press_key/double_click/right_click）：在目标可见框内依次探测中心和 8 个偏移点，取第一个属于目标的点派发；全部被挡则滚到视野中央再探测一次。仍被挡 → `TARGET_BLOCKED`、`dispatch=not_sent`，`observed` 含 `blocker`（遮挡元素）、`layer`（遮挡层：与目标不共祖先的最高节点）和 `layerControls`（层内最多 8 个未禁用的快照控件），均用跨快照稳定的 `key` 和快照已有的 role/label，不读取额外页面文本。
- **点击**：hover/down/focus/up 发出后目标被替换或遮挡 → `TARGET_CHANGED`、`dispatch=unknown`，不继续 click。命中目标内部无 click 方法的 SVG/path 时，向命中元素派发一次冒泡 MouseEvent。
- **目标外观**（click/hover/double_click/right_click，含真实输入）：派发前记下目标、2 层祖先和前 50 个后代的 class、style、aria-pressed/checked/selected/current、data-*（表单控件不取 data-*；不读字段值；每值截 120 字符），以及目标计算样式 background-color、border-color、outline、opacity、transform、box-shadow。稳定观察后快照未变但这些变了 → `TARGET_VISUAL_CHANGED`（unknown、sent、observe），message 提示可能已选中/切换、不要重复点击；焦点移动时忽略计算样式（`:focus` 样式不算）。记录只在内容脚本内比较，不进回执。带 expected 时仍按条件回报。
- **fill**：原型 value setter（绕过实例 value 跟踪器，不注入主世界）。先用脱离文档的同类型 input 检查浏览器值清洗，不能原样保留则 `INVALID_FIELD_VALUE`、not_sent。聚焦后重核签名，派发可取消 beforeinput（`insertReplacementText`）；被取消 → `INPUT_CANCELLED`、dispatch=unknown，不再写值。之后 setter + input/change。事件处理中节点被替换/隐藏/禁用 → `TARGET_CHANGED`。
- **contenteditable**：仅 `contenteditable` 为 true/空/plaintext-only，且只含文本节点和无属性 `<br>`。写入 textContent（≤ 4000 字符），不解析 HTML、不用 execCommand。其他结构 → `UNSUPPORTED_EDITABLE`、not_sent，不改节点。
- **ARIA 选择控件**：先 click 打开，再按新快照选项点击。选项按 listbox 分组，名称取自身标签或唯一可见 combobox（aria-controls/aria-owns）；多个 owner 不任选。
- **press_key / double_click / right_click**：先做命中检查并聚焦，派发前或事件之间目标、焦点或遮挡变化即中断（`TARGET_CHANGED`）；双击中断时第一次点击可能已生效。press_key 的 keydown 发出后，值、文字或焦点的变化算按键效果（如 Enter 添加待办并清空输入框），不再中断；目标仍有焦点才补发 keyup，否则回执带 `keyup:false`。

## 真实输入

`cdp-tools.js`（`PageAgentCdp`，后台在 `browser-tools.js` 之前加载）经 `chrome.debugger` 发送真实鼠标输入。

- 开关：只有 storage.local `debuggerEnabled === true`（设置页「真实输入与截图」，默认关）时才 attach。`ensure` 每次读取，关闭时抛 `REAL_INPUT_DISABLED`（not_sent），什么都不连接；监听 `storage.onChanged`，改为非 true 时立即 detach 所有会话。运行器每轮读 `tools.realInputEnabled()` 作为 `capabilities.realInput`：关闭时系统提示与原生工具里没有页面截图来源（`view_image` 只剩 `imageN`）、`click_point` 和 `trusted`，NO_CHANGE 提示改为只观察核实；模型仍发出时运行器/后台记 `REAL_INPUT_DISABLED`（not_sent、replan，message 提示可在设置中开启），不量坐标、不遮盖、不截图。

- 会话：每个执行标签页一个，归属一个 taskId；第一次需要时 attach（协议 1.3），同一任务内复用，换任务先 detach。运行器在任务离开 running/waiting_page（完成、暂停、停止、失败）、接管、结束、清空、切换执行标签时调用 `tools.releaseInput(tabId)` detach；worker 启动恢复时对非运行任务的标签也 detach 一次（清理重启前遗留的会话）。标签关闭由浏览器自动断开。
- 命令白名单：`Input.dispatchMouseEvent` 与[截图](#截图)用的 `Page.captureScreenshot`。鼠标参数只允许 type（mouseMoved/mousePressed/mouseReleased）、x、y、button（none/left）、buttons、clickCount（0/1）、pointerType=mouse。点击 = 移动 + 按下 + 抬起；悬停 = 移动。不转发其他方法，不接受模型给的方法或参数；坐标来自快照目标，或来自运行时核对换算后的 [坐标点击](#坐标点击)。
- attach 后、按下前都核对运行代次（`live`），代次已变则不发送；释放发生在 attach 途中则不发送并 detach。
- 何时用（`browser-tools.realInput`，只用于 click/hover，顶层或同源框架目标；跨源框架路由目标不支持）。已发出的合成事件从不由运行时改用真实输入重发：页面没变化不能证明没效果（效果可能延迟或不可见）。
  - 到不了（`unreachable`，自动）：命中点是 iframe/frame/embed/object（合成事件进不了嵌入文档），内容脚本在派发任何事件前抛 `SYNTHETIC_UNREACHABLE`（unsupported、not_sent）并记住目标，后台经 `agent:point` 取坐标后用真实输入。
  - 模型请求（`trusted`）：计划带 `trusted:true`（`agentPlan` 只接受 click/hover 的布尔值）时不发合成事件；后台发 `agent:aim`，内容脚本按 `agent:execute` 的规则核对快照与计划、消费快照、记住目标并返回坐标。核对失败（`STALE`、`TARGET_BLOCKED` 等）与合成路径一样抛给运行器。`executing` 检查点照常先写。
  - 合成点击/悬停回执为 `NO_CHANGE` 时，message 末尾提示：选中/切换类目标可能已变化而文字不变，再点会撤销；先截图或观察核实，确认没反应才加 `trusted:true` 再试一次。运行时不自动重试。
  - 坐标：`agent:point`/`agent:aim` 对同一节点核对存活、签名、可见、未变为敏感字段，再走合成点击的命中检查（滚入视野、遮挡、iframe 可见框），返回顶层视口 CSS 像素，同源框架加 iframe 偏移；遮挡（`TARGET_BLOCKED`）不派发，因为真实点击同样落在遮挡层上。新 observe 清除记住的目标；合成事件已派发的目标不给坐标。
  - 派发后 `agent:settle` 只做稳定观察和 expected 核对（不再发事件）；回执 `observed.input='cdp'`、`observed.fallback`（`unreachable`/`trusted`），message 前缀说明输入方式。回执丢失时：地址变了或在加载 → `DOCUMENT_CHANGED`（navigation），否则 `CDP_RESULT_UNKNOWN`，都 unknown、不重发。
  - 开关关闭时：到不了类与 `trusted` 类都返回 `REAL_INPUT_DISABLED`（unsupported、not_sent、replan），不发 `agent:point`/`agent:aim`。
  - 未发送时：到不了类返回 `SYNTHETIC_UNREACHABLE`，`trusted` 类返回 `REAL_INPUT_NOT_SENT`（unsupported、not_sent、replan），都带 `observed.input='none'` 与 `cdp {code,message}`，运行器不等待 expected，直接交回模型。按下后失败返回 unknown/unknown 与 CDP code。
- 错误 code（都不自动重连、不重发）：`CDP_UNAVAILABLE`（无 API 或 attach 失败）、`CDP_BUSY`（DevTools 或其他扩展已占用；若是重启前遗留的自身会话则先 detach 再 attach 一次）、`CDP_CANCELLED`（用户在提示条点取消，`onDetach` reason=canceled_by_user，本任务之后不再 attach，新任务重新判断；只存于后台内存）、`CDP_DETACHED`（发送中断开）、`CDP_COMMAND_FAILED`、`CDP_METHOD_DENIED`。错误带 `dispatch`：按下（悬停为移动）之前失败为 not_sent，之后为 unknown。

## 坐标点击

`click_point` 让能看图的模型点快照里没有的位置（图片、画布、嵌入内容）。`capabilities.vision`（看图能力不是已知不支持）与 `capabilities.realInput`（[开关](#真实输入)）都为真时才进工具列表和系统提示；否则运行器记 `REAL_INPUT_DISABLED`（开关关）或 `POINT_UNAVAILABLE`，不派发。

- 坐标空间：任务字段 `lastView` 只记最新一次 `view_image` 截图，且只在来源为 `viewport` 时有值（元素/区域截图或识别路径清空它）：`{shotId, tabId, documentId, url, time, image {width,height}, area, viewport, scroll, seen}`。截图随模型请求发出后 `seen=true`；截图丢失（`SHOT_EXPIRED`）或改走识别时清空。
- 运行器（`runtime.pointAction`）：要求 `seen`、同一执行标签、当前快照的 documentId 与 URL 一致、截图不超过 60 秒，否则 `POINT_NO_SCREENSHOT`；点须在图内，按 `area + 像素 × area / image` 换成顶层视口 CSS 像素后仍在视口内，否则 `POINT_OUTSIDE`。通过后清空 `lastView`（一张截图只点一次），写 pending 并走普通 `execute`（先写 `executing` 检查点）。
- 后台（`browser-tools.pointClick`）：核对来源与标签 URL，内容脚本 `agent:viewport` 只读返回 documentId、URL、视口大小和滚动位置；与截图时不一致（滚动差超过 1px、窗口大小变化、换文档）记 `POINT_STALE`，不派发。之后经 `cdp-tools.input` 发移动 + 按下 + 抬起。
- 回执：`POINT_CLICKED`（unknown/sent，recovery=observe），点击后地址变化或在加载为 `DOCUMENT_CHANGED`（navigation）；`observed {input:'cdp', target:'point', x, y}`（截图像素），未派发时 `input:'none'`。按下后失败为 unknown/unknown，不重发。带 expected 时照常进入核对。

## 截图

`view_image` 由运行器处理（`runtime.viewImage`），模型只给来源，不给坐标或区域。

| 来源 | 能看图（或未知）的模型 | 不能看图（`visionSupport`） |
|---|---|---|
| `viewport` / 元素 `tN` / 区域 `rN` | 截图存入附图库，只随下一次模型请求发送一次 → `IMAGE_NEXT_TURN` | 截图 + 问题 + 目标交给识别模型 → `IMAGE_RECOGNIZED`，不存图 |
| 附图 `imageN` | 每轮已带图，直接返回 `IMAGE_IN_REQUEST`，不截图不识别 | 用该附图和新问题再识别一次 → `IMAGE_RECOGNIZED` |

- 捕获（`browser-tools.screenshot`）：核对来源与标签 URL → 内容脚本 `agent:shot` 按当前快照 ID 找到节点（须存活、可见；不完全在视口内时 `scrollIntoView` 后等 150ms），量出可见框（顶层视口 CSS 像素，含同源框架偏移与 overflow 裁剪），`viewport` 为整个视口 → 后台以「可见框 + 顶层滚动偏移」为 clip，`scale = min(1, 1568 / (长边 × devicePixelRatio))`，经 `cdp-tools.capture` 发一次 `Page.captureScreenshot`（JPEG，quality 70，`captureBeyondViewport:false`，15 秒超时）→ `finally` 发 `agent:unshot` 移除遮盖。白名单校验 clip 只含 x/y/width/height/scale 且 scale ≤ 1。不激活或聚焦标签页；会话与[真实输入](#真实输入)共用（同一 taskId，同样的 attach/detach 与错误 code）。
- 遮盖（`core.agentMaskBoxes` + 内容脚本）：未授权敏感字段时遮盖 `agentSensitiveSelector` 匹配的元素（顶层、可读同源框架、开放 Shadow DOM）和所有读不到文档的框架（跨源、嵌套过深）；已授权时只遮盖文件选择框。每处外扩 2px，画成顶层 `position:fixed` 黑块（`data-page-agent="mask"`，不进快照），插入后逐块核对位置与可见性；量不到、放不准或根元素半透明即 `MASK_FAILED`，不截图、不留遮盖。内容脚本 15 秒后自行移除未收到 `agent:unshot` 的遮盖。封闭 Shadow DOM 和无标准标记的敏感内容不在遮盖范围内。
- 页面来源（`viewport`/`tN`/`rN`）须开启[开关](#真实输入)，否则 `REAL_INPUT_DISABLED`，不截图；附图 `imageN` 不需要调试通道。
- 拒绝：跨源框架路由的目标（`VIEW_IMAGE_UNSUPPORTED`，可改用 viewport）、不在快照中的 ID（`TARGET_MISSING`）、过期快照或节点（`STALE`）、不可见（`TARGET_HIDDEN`）、`CAPTURE_TIMEOUT`、`CAPTURE_FAILED`、`CDP_*`、识别失败 `RECOGNITION_FAILED`、无附图 `IMAGE_NOT_FOUND`。都是交回模型的工具结果，不暂停任务。
- 识别文字放在 `observed {source, question?, note:'来自图片识别，可能有误', untrusted:true, text}`，text ≤ 2000 字符，并按 JSON 转义后长度裁到 4500 字符的 observed 上限以内。识别计一轮，失败重试见 [附图](context-and-skills.md#附图)。
- 截图暂存与发送见 [附图](context-and-skills.md#附图)。

## 导航

内部页启动的浏览器对话只读取标签 URL 元数据；导航来源由可信后台标记为 `browser`，跳过 DOM 快照消费和内部页主机授权，但仍校验目标主机权限、来源 URL 和运行代次。

1. 运行器把 navigate 记入检查点并绑定 `url_equals`（规范化目标 URL）。
2. `browser-tools` 校验：源/目标有主机权限、当前标签 URL 未变；拒绝凭据、内部协议、相对 URL。不要求目标预先加入任务。
3. `agent:prepare-navigation` 让内容脚本核对并消费快照（不改网页）；内容脚本本身拒绝执行 navigate。
4. 后台调用一次 `tabs.update`：成功 → `NAVIGATION_DISPATCHED`、sent、status=unknown；回执失败 → `NAVIGATION_UNKNOWN`，只读等待 URL，不补发。

跨来源只接受 URL 条件，用浏览器当前 URL 核对。observe/verify/重连都带 `expectedOrigin`，内容脚本在捕获 DOM 前检查，来源不符则拒读。

## 任务标签页

- tabRef（`tab0`…`tab999`）只取自模型输入的 `tabs` 目录；`tab_switch` 另接受 `otherTabs` 的 `open1`…`open99`。校验器拒绝数字 tabId、value 和 expected；运行器再核对目录与 `tabOwners`。规则见 [运行器](agent-runtime.md#多标签执行)。
- `browser-tools.openTab(url, {openerTabId})`：拒绝凭据与非 HTTP/HTTPS，要求目标主机权限；`tabs.create({active:false, windowId: opener 窗口, openerTabId})`，只返回浏览器给出的 tabId。
- `closeTab(tabId)`：一次 `tabs.remove`，结果由运行器向浏览器确认。
- 内容脚本不处理这三个动作（路由不是 content）。

## 结果（V2）

字段：version、operationId、documentId、status、dispatch、scope、code、observed、evidence、recovery、message。

- status：success / not_satisfied / pending / unknown / unsupported / error。
- dispatch：not_sent / sent / unknown。scope：dispatch / ui / page。success 只对应本次 expected，不代表服务器成功或任务完成。
- 控制流只看 code/status，不解析 message。旧 navigation/connection/verification 返回由 `tool-protocol.js` 适配；回执丢失一律 unknown。只读 verify 的 not_sent 不覆盖原动作的 dispatch。
- scroll 回执 observed 含 axis/before/after/delta/atStart/atEnd；wheel 回执的 deltaX/deltaY 是输入量，defaultPrevented 不是成功证据。
- 常见 code：`SYNTHETIC_UNREACHABLE`、`CDP_*`（见[真实输入](#真实输入)）、`STALE`、`NAVIGATION`、`PAGE_BUSY`、`NO_CHANGE`、`TARGET_VISUAL_CHANGED`、`TARGET_BLOCKED`、`TARGET_CHANGED`、`TARGET_MISSING`、`AMBIGUOUS_TARGET`、`CONDITION_TIMEOUT`、`DELAY_ELAPSED`、`INPUT_CANCELLED`、`INVALID_FIELD_VALUE`、`UNSUPPORTED_EDITABLE`、`NAVIGATION_DISPATCHED`、`NAVIGATION_UNKNOWN`。

## expected 条件

1–5 个 AND 条件，每项 `{kind, id, value?}` 或 `{kind, target, value?}`；target 为受限语义目标 `{category:'element'|'region', label, role?, name?, group?}`，不接受选择器。

| kind | 核对 |
|---|---|
| field_equals | 字段实际值（含 contenteditable 纯文本）；不等时忽略空白改写再比较 |
| checked_equals | 勾选状态；value 须为布尔，字符串 "true"/"false"（不分大小写）在 `agentPlan` 中转换 |
| selected_equals / expanded_equals | 显式 aria-selected / aria-expanded；缺失或非法为 unknown |
| element_visible / element_absent | 存在且可见 / 在完整观察范围内不存在 |
| text_present | 指定区域内出现文字（必须指向具体区域）；同样忽略空白改写 |
| url_changed / url_equals | URL；普通 wait/verify/done 限当前来源 |

- 动作后约 600ms 短暂稳定观察，再按 expected 检查；未满足保存检查点，后续 tick 只读核对，不重复动作。
- 目标节点被替换时按名称、role、分组唯一匹配后核对，不补写；找不到、多项匹配或范围截断 → unknown。
- 核对会对条件中的具名区域额外只读查找（最多随 5 个条件，按节点 key 去重），不增加模型请求；不提升原覆盖完整性。

## 连接与页面状态

回执丢失后先查标签：加载中或 URL 已变则等新页；同页则只重连读取（必要时补注入），不重复执行。`PAGE_BUSY` 等上个操作结束。无法注入时提示点击扩展图标或重新授权。

## 视觉反馈

`page-pointer.js` 在 isolated world 创建禁止命中的显示层（内部用封闭 shadow root 隔离样式），从抽取和遮挡判断中排除。开始观察时在主页面显示箭头，等待模型和动作间隙保留；只读观察、框架检查和预期核对不移动箭头；core 派发目标动作时从箭头当前显示位置平滑移动，时长随距离为 240–600ms；同目标重复定位不重启动画，途中换目标从当前位置继续。点击圆环在箭头到达后显示；视觉动画不阻塞网页操作，系统「减少动态效果」开启时直接定位。边框和点击圆环约 900ms 后隐藏；滚动/缩放只清高亮并把箭头留在视口内。后台页隐藏显示层，返回时恢复；pagehide、停止、接管或任务非活动时清理。后台的 `agent:clear-pointer` 同时清理已注入的子框架；跨源子框架内的精确指针仍为短暂反馈，主页面箭头指向对应框架。不新增权限，不保存状态，不增加模型请求。

## run_script

模型编写的 JavaScript 只能经此动作、通过 `chrome.userScripts.execute` 运行。实现在 `extension/script-tools.js`（`PageAgentScriptTools`），后台在 `core.js` 之前加载，设置页也加载；内容脚本不加载，网页执行器照旧拒绝该动作。

- 前提：可选权限 `userScripts`（设置页「脚本执行」由点击申请）、Chrome 135+（`userScripts.execute`），且扩展详情页「允许用户脚本」已打开（Chrome 138+；135–137 为开发者模式）。`status(chrome)` 返回 `{permission, api, available}`。
- 暴露：后台每轮计算一次 `available`，作为 `capabilities.scripts` 同时决定系统提示词末尾的 run_script 说明、原生 tools 列表和 JSON 模式的动作列表。不可用的轮次模型看不到该工具（不占 schema 上下文，也不会请求用户无法批准的脚本）。注册表始终含 run_script，`agentPlan` 照常校验参数；模型在不可用的轮次仍返回它时不执行，暂停为 `access`，消息写明缺权限还是缺浏览器开关。
- 参数：value 为代码字符串（≤ 20000 字符）或 `{code, world}`，world 为 `USER_SCRIPT`（默认，隔离环境、可访问 DOM、不受网页 CSP 限制）或 `MAIN`（可访问网页 JS 全局；改写 `window.confirm` 等网页函数只在 MAIN 生效）；不接受 id。代码作为 async 函数体在当前标签顶层框架执行，`return` 的值转成字符串返回。
- 批准：商店包执行前暂停为 `script_approval`，侧栏显示完整代码，用户选择「允许一次」或「本任务内允许」（之后本任务在同一标签页、同一来源的脚本自动执行，完整代码仍记入对话，可随时撤销）；没有跨任务的「始终允许」。流程见 [运行器](agent-runtime.md#脚本批准)。
- 执行：校验来源与主机权限、标签 URL 与待执行记录一致、`status` 可用，再用 `agent:document` 只读探测内容脚本的文档 ID（不一致或无响应记 `STALE`，不执行），之后调用一次 `chrome.userScripts.execute`；USER_SCRIPT 环境设置为允许 eval。结果 `SCRIPT_RESULT`（`observed.result` ≤ 4000 字符，`truncated`、`world`）、`SCRIPT_ERROR`（`observed.error`）、`SCRIPT_TIMEOUT`（30 秒未返回，status=unknown，不重发）。dispatch=sent、recovery=observe，执行后重新观察。
- 未执行的回执（dispatch=not_sent）：`SCRIPT_REJECTED`（用户拒绝，recovery=replan）、`STALE`（页面或文档已变）、`SCRIPT_DISCARDED`（停止、接管、补充指令、导航、执行标签关闭使待批准请求作废）、`PERMISSION_DENIED`（执行前发现不可用）。

## 未支持

快照差异、点击/导航类批量动作、按截图坐标的悬停/拖拽/输入、整页长截图、嵌套/重定向/重复 URL iframe、Shadow DOM、原生 confirm/alert、复杂编辑器、IME、RTL 负向 scrollLeft、多标签工具。其中同源 iframe、开放式 Shadow DOM 等可由 run_script 处理，范围见[使用指南](usage.md#脚本执行)。
