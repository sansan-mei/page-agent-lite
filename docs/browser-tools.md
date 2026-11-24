# 网页工具协议

`browser-tools.js`（后台）封装 tab、inject、observe、execute、verify、导航；`content.js` 只接受后台消息，不发模型请求。动作集合由 `core.js` 的冻结注册表 `agentToolRegistry` 定义，校验器、提示目录和运行器防重放共用同一份。

## 动作

模型每轮返回一个严格 JSON 动作，如 `{"action":"click","id":"t2","reply":"保存","expected":[...]}`。

| action | 参数 | 路由 | 说明 |
|---|---|---|---|
| done / pause | reply | runtime | 完成 / 受阻暂停 |
| observe | 可选 value（见下） | runtime | 只读刷新快照 |
| verify | expected | runtime | 立即只读核对 |
| wait | expected + 可选 timeoutMs；或仅 timeoutMs | runtime | 条件等待（默认 10s，最多 30s）；仅 timeoutMs 为纯延时（100–30000ms） |
| history_read | id、value=offset | runtime | 读当前来源的压缩归档，每次 4000 字符 |
| memory_* / site_memory_* / global_memory_* | read/write/delete/clear | runtime | 三层记忆，见 [上下文](context-and-skills.md) |
| click | id | content | 滚入视野、命中检查、pointer/mouse/focus 序列后一次 click |
| fill | id、字符串 value | content | input / textarea / 简单 contenteditable |
| check | id、布尔 value | content | 原生 radio / checkbox |
| select | id、字符串 value | content | 存在且未禁用的 option |
| hover | id | content | pointer/mouse over/enter/move，无 down/up/click |
| scroll | value=up/down/left/right，可选容器 id | content | 600px；不传 id 滚窗口 |
| wheel | id、value=方向 | content | 一次可取消 WheelEvent（±600 像素），只触发监听器，无原生滚动 |
| press_key | id、value | content | keydown/keyup，见下 |
| double_click | id | content | 两次受保护 click 后派发 detail=2 的 dblclick |
| right_click | id | content | 右键 pointer/mouse down/up + contextmenu，不打开原生菜单 |
| navigate | 绝对 HTTP/HTTPS URL（≤ 2000 字符） | browser | 见 [导航](#导航) |
| tab_switch | id=tabRef | runtime | 切换执行标签页，见 [任务标签页](#任务标签页) |
| tab_open | 绝对 HTTP/HTTPS URL，无 id/expected | browser | 后台打开并登记为任务标签页，切换执行目标 |
| tab_close | id=tabRef | browser | 关闭非执行中的任务创建标签页 |

- content 路由的动作（hover、scroll 除外）都有防重放保护；目标必须是当前快照 ID。不接受坐标、选择器、脚本或 HTML。
- press_key：修饰键 Control/Alt/Shift/Meta（不可重复）；主键 Enter/Escape/Tab/Space/方向键/Home/End/PageUp/PageDown/Backspace/Delete 或小写 a–z。不保持按下状态，不触发浏览器原生编辑/快捷键；文本用 fill。
- 合成事件都不是 `isTrusted` 输入。拖拽、长按、系统输入、纯 CSS `:hover` 不支持。

## observe 快照

`agent:observe` 返回 `{documentId, snapshotId, url, page}`。

| 内容 | 上限 |
|---|---|
| 正文 | 16000 字符/段 |
| 交互元素（临时 ID `t0`…） | 120 个/批；每个 select 40 个选项 |
| 区域（临时 ID `r0`…） | 40 个/批；总文字 5000，单区域 1000 |
| 分组上下文（fieldset、radiogroup、题目容器、listbox） | 5000 字符 |
| 元素语义 context（≤3 层具名祖先 + aria-describedby ≤ 300 字符） | 合计 4000 字符 |

- 排序：弹窗（open dialog、role=dialog/alertdialog、aria-modal）优先，其次与视口相交（考虑 overflow 祖先裁剪）。`inViewport` 只是几何相交。
- 识别的交互元素：原生控件、role=link/menuitem/switch/combobox/option/tab、onclick、非负 tabindex、pointer 样式边界。可点击行内的子元素若自带交互线索（a、label、summary、aria-haspopup/expanded/pressed、data-testid）单独列出，如悬浮才显形的「添加/更多」。onclick 只用于识别，不读取执行。标签来自 label、aria-labelledby、title。
- 元素可带 `scroll {x,y,maxX,maxY}`、expanded/selected/haspopup、`controlledLabels`、`editable`（plain_text / unsupported_structure）、`context {path, description}`。
- `coverage` 分别标注元素、区域、正文是否完整；`page.viewport` 给出窗口尺寸与滚动范围。没读到不等于不存在。
- 默认排除：密码/文件/隐藏字段、`autocomplete` 含 current-password/new-password/one-time-code/cc-number/cc-csc 的元素及子树（不区分大小写，支持 section-/billing 前缀）、hidden/aria-hidden、自身或祖先 display:none、自身计算样式 visibility:hidden/collapse（子元素可用 visible 覆盖祖先）、扩展自身 UI。opacity:0 不排除。存在敏感排除时 `coverage.sensitiveExcluded=true`。这不是全面脱敏。可信后台传入本对话的敏感字段授权时，允许密码及上述 autocomplete 字段；文件、隐藏字段始终排除。授权绑定快照，执行消息的授权不一致则拒绝旧快照。模型只能用 `request_sensitive_access` 请求侧栏确认，不能自行授权；交互见 [使用指南](usage.md#敏感字段授权)。

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
- **fill**：原型 value setter（绕过实例 value 跟踪器，不注入主世界）。先用脱离文档的同类型 input 检查浏览器值清洗，不能原样保留则 `INVALID_FIELD_VALUE`、not_sent。聚焦后重核签名，派发可取消 beforeinput（`insertReplacementText`）；被取消 → `INPUT_CANCELLED`、dispatch=unknown，不再写值。之后 setter + input/change。事件处理中节点被替换/隐藏/禁用 → `TARGET_CHANGED`。
- **contenteditable**：仅 `contenteditable` 为 true/空/plaintext-only，且只含文本节点和无属性 `<br>`。写入 textContent（≤ 4000 字符），不解析 HTML、不用 execCommand。其他结构 → `UNSUPPORTED_EDITABLE`、not_sent，不改节点。
- **ARIA 选择控件**：先 click 打开，再按新快照选项点击。选项按 listbox 分组，名称取自身标签或唯一可见 combobox（aria-controls/aria-owns）；多个 owner 不任选。
- **press_key / double_click / right_click**：先做命中检查并聚焦，事件间目标、焦点或遮挡变化即中断；双击中断时第一次点击可能已生效。

## 导航

内部页启动的浏览器对话只读取标签 URL 元数据；导航来源由可信后台标记为 `browser`，跳过 DOM 快照消费和内部页主机授权，但仍校验目标主机权限、来源 URL 和运行代次。

1. 运行器把 navigate 记入检查点并绑定 `url_equals`（规范化目标 URL）。
2. `browser-tools` 校验：源/目标有主机权限、当前标签 URL 未变；拒绝凭据、内部协议、相对 URL。不要求目标预先加入任务。
3. `agent:prepare-navigation` 让内容脚本核对并消费快照（不改网页）；内容脚本本身拒绝执行 navigate。
4. 后台调用一次 `tabs.update`：成功 → `NAVIGATION_DISPATCHED`、sent、status=unknown；回执失败 → `NAVIGATION_UNKNOWN`，只读等待 URL，不补发。

跨来源只接受 URL 条件，用浏览器当前 URL 核对。observe/verify/重连都带 `expectedOrigin`，内容脚本在捕获 DOM 前检查，来源不符则拒读。

## 任务标签页

- tabRef（`tab0`…`tab999`）只取自模型输入的 `tabs` 目录，校验器拒绝数字 tabId、value 和 expected；运行器再核对目录与 `tabOwners`。规则见 [运行器](agent-runtime.md#多标签执行)。
- `browser-tools.openTab(url, {openerTabId})`：拒绝凭据与非 HTTP/HTTPS，要求目标主机权限；`tabs.create({active:false, windowId: opener 窗口, openerTabId})`，只返回浏览器给出的 tabId。
- `closeTab(tabId)`：一次 `tabs.remove`，结果由运行器向浏览器确认。
- 内容脚本不处理这三个动作（路由不是 content）。

## 结果（V2）

字段：version、operationId、documentId、status、dispatch、scope、code、observed、evidence、recovery、message。

- status：success / not_satisfied / pending / unknown / unsupported / error。
- dispatch：not_sent / sent / unknown。scope：dispatch / ui / page。success 只对应本次 expected，不代表服务器成功或任务完成。
- 控制流只看 code/status，不解析 message。旧 navigation/connection/verification 返回由 `tool-protocol.js` 适配；回执丢失一律 unknown。只读 verify 的 not_sent 不覆盖原动作的 dispatch。
- scroll 回执 observed 含 axis/before/after/delta/atStart/atEnd；wheel 回执的 deltaX/deltaY 是输入量，defaultPrevented 不是成功证据。
- 常见 code：`STALE`、`NAVIGATION`、`PAGE_BUSY`、`NO_CHANGE`、`TARGET_BLOCKED`、`TARGET_CHANGED`、`TARGET_MISSING`、`AMBIGUOUS_TARGET`、`CONDITION_TIMEOUT`、`DELAY_ELAPSED`、`INPUT_CANCELLED`、`INVALID_FIELD_VALUE`、`UNSUPPORTED_EDITABLE`、`NAVIGATION_DISPATCHED`、`NAVIGATION_UNKNOWN`。

## expected 条件

1–5 个 AND 条件，每项 `{kind, id, value?}` 或 `{kind, target, value?}`；target 为受限语义目标 `{category:'element'|'region', label, role?, name?, group?}`，不接受选择器。

| kind | 核对 |
|---|---|
| field_equals | 字段实际值（含 contenteditable 纯文本） |
| checked_equals | 勾选状态 |
| selected_equals / expanded_equals | 显式 aria-selected / aria-expanded；缺失或非法为 unknown |
| element_visible / element_absent | 存在且可见 / 在完整观察范围内不存在 |
| text_present | 指定区域内出现文字（必须指向具体区域） |
| url_changed / url_equals | URL；普通 wait/verify/done 限当前来源 |

- 动作后约 600ms 短暂稳定观察，再按 expected 检查；未满足保存检查点，后续 tick 只读核对，不重复动作。
- 目标节点被替换时按名称、role、分组唯一匹配后核对，不补写；找不到、多项匹配或范围截断 → unknown。
- 核对会对条件中的具名区域额外只读查找（最多随 5 个条件，按节点 key 去重），不增加模型请求；不提升原覆盖完整性。

## 连接与页面状态

回执丢失后先查标签：加载中或 URL 已变则等新页；同页则只重连读取（必要时补注入），不重复执行。`PAGE_BUSY` 等上个操作结束。无法注入时提示点击扩展图标或重新授权。

## 视觉反馈

`page-pointer.js` 在 isolated world 创建禁止命中的显示层（内部用封闭 shadow root 隔离样式），从抽取和遮挡判断中排除。core 校验目标后触发，动画不阻塞操作；约 900ms 隐藏，pagehide/scroll/resize/visibilitychange 清理，后台停止或任务非活动时发 `agent:clear-pointer`。不新增权限，不保存状态，不增加模型请求。

## 开发版 run_script

仅 `npm run build:dev` 生成的 `dist/extension-dev/`（本地加载，不上架）提供；商店包 `extension/` 没有该动作和 `userScripts` 权限。

- 构建：`scripts/build-dev.cjs` 原样复制 `extension/`，加入 `dev/dev-tools.js`、`dev/background-dev.js`；manifest 名称加「(Dev)」（版本号不变）、增加 `userScripts` 权限、worker 入口改为 `background-dev.js`（先加载 dev-tools 再加载 background）。
- 注册：`core.js` 建表时读取已加载的 `PageAgentDevTools.registry`，之后仍冻结；提示词末尾追加开发版说明。内容脚本不加载 dev-tools，网页执行器照旧拒绝该动作。
- 参数：value 为代码字符串（≤ 20000 字符）或 `{code, world}`，world 为 `USER_SCRIPT`（默认，隔离环境、可访问 DOM、不受网页 CSP 限制）或 `MAIN`（可访问网页 JS 全局）；不接受 id。代码作为 async 函数体在当前标签顶层框架执行，`return` 的值转成字符串返回。
- 执行：校验来源与主机权限、标签 URL 与快照一致后调用一次 `chrome.userScripts.execute`；USER_SCRIPT 环境设置为允许 eval。结果 `SCRIPT_RESULT`（`observed.result` ≤ 4000 字符，`truncated`、`world`）、`SCRIPT_ERROR`（`observed.error`）、`SCRIPT_TIMEOUT`（30 秒未返回，status=unknown，不重发）。dispatch=sent、recovery=observe，执行后重新观察。
- 前提：Chrome 135+，并在扩展详情页打开「允许用户脚本」（138 以下为开发者模式）；不可用时 `PERMISSION_DENIED`、not_sent。每次执行不再弹确认。

## 未支持

快照差异、批量动作、截图/视觉、iframe、Shadow DOM、原生 confirm/alert、复杂编辑器、IME、RTL 负向 scrollLeft、多标签工具。
