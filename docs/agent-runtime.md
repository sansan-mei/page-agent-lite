# 任务运行器

`runtime.js` 通过依赖注入使用 store、tools、siteMemory、model、summarize、identity、preferences、scheduler、scriptAccess（每轮 run_script 是否可用）和 autoApproveScripts（仅开发版为 true），不访问 DOM。`taskId` 标识任务；`token` 是运行代次，停止/替换/接管/记忆变更时轮换，旧请求的迟到结果一律丢弃。

## 状态

| status | 含义 |
|---|---|
| running | 可继续推进 |
| waiting_page | 等待页面就绪，由事件或 alarm 重试 |
| waiting_confirmation | 旧版兼容；继续时丢弃待确认动作并重新规划 |
| paused | 带 `reason` 暂停，如预算耗尽、无进展、结果不确定、`user_takeover`、`scope_changed`、`permission_denied`、`scope_reconciled`、`input`、`script_approval`（待批准脚本）、`script_stale`（待批准脚本因页面变化作废） |
| stopped | 用户停止 |
| failed | 未恢复的错误 |
| completed | 模型返回 done（有完成条件时已核实） |
| ended | 用户结束或成员关闭（`reason=member_closed`）；下次发送新建任务 |

`phase`：observe、thinking、compacting、confirm、approved、executing、verifying、idle，用于中断恢复。verifying 阶段不调用模型、不重复动作。

## 浏览器对话

内部页以 `origin=browser` 和空 `allowedOrigins` 新建任务，不读取 DOM 或网站记忆，只允许回答、提问和提出 HTTP/HTTPS 导航。已有浏览器主机权限时直接导航；缺少时暂停为 `browser_target`，明确说明尚未打开、任务未完成，侧栏授权后继续。导航仍先写 executing 和 URL 核对检查点，按原 deadline 核对，不重发。进入网站后沿用任务身份与预算，并走跨来源隔离。浏览器对话的回答保留为结果，后续发送沿用对话。

## 一次 tick

1. 读取任务，核对运行代次、当前 URL 来源属于 `allowedOrigins` 且有主机权限、页面就绪。来源变化走 [跨来源切换](#跨来源切换)。
2. `executing` 恢复：有条件则只读核对，无条件则暂停；`approved` 页面已变则重新规划（已批准的 run_script 记 `STALE`，不执行）。
3. 普通路径：读取快照（`nextObservation` 指定的范围只用一次）；超过上下文预算先压缩（phase=compacting），否则计一轮并调用模型（phase=thinking）。本轮 `scriptAccess()` 的结果作为 `capabilities` 传给模型请求和上下文估算。
4. 模型返回后再次核对代次、URL、记忆版本，任一变化则丢弃。
5. 严格解析动作（`backend.parseChatResponse` + 动作校验）。done 有 expected 或已保存的完成条件必须核实，否则标为“模型报告完成”；pause 表示受阻未完成。
6. 网页动作前保存 `executing` 检查点，执行后保存结果并调度下一 tick。记忆、history_read 等由后台处理，不发网页。

同一任务的 tick 串行；运行锁、去重 jobs、请求控制器、timer 和 alarm（`task-id:<taskId>`）都以 taskId 为身份。tabId 入口通过标签发布队列防替换竞态；`tick(tabId, expectedTaskId)` 中的过期调度不会操作同一标签上的新任务。

## 预算

- 默认 100 轮，0 不限；每次模型请求（含失败重试、摘要请求）计一轮。翻页、跨来源、worker 恢复都保留累计轮数。
- 预算耗尽或已完成后「继续」开启新预算；停止/一般失败后继续保留剩余预算。补充指令不重置预算。
- 条件等待每 tick 只读检查一次，不消耗模型轮数。`metrics` 分别统计观察、核对、动作次数。

## 目标模式

任务字段 `goalMode`（缺省 false）。新建任务时由侧栏「目标模式」开关经 `task:submit` 的 `goalMode` 带入；补充指令带布尔值时同步；进行中用 `task:goal-mode {taskId, enabled}`（仅可信侧栏，已完成/已结束拒绝）切换，不自动继续。跨来源切换保留。

| 项 | 默认 | 目标模式 |
|---|---|---|
| 核对未通过后重新规划（`verificationRecoveries`） | 动作 2 次 | 动作、wait、完成条件共 5 次 |
| 目标过期/遮挡重新定位（`recoveryCount`） | 2 次 | 5 次 |
| 普通阻碍重新规划（`helpAttempts`） | 3 次 | 8 次 |
| 同动作同目标连续 `NO_CHANGE` 暂停 | 3 条 | 6 条 |
| `uncertainClicks` | 运行时拦截同文档同目标 | 不拦截，只作为提示交给模型 |

模型输入带 `goalMode=true`，提示模型优先重新规划、只在页面显示效果缺失时重做，且不重复可能已发生的提交/删除/支付/发送。不变的边界：轮数预算、`executing` 中断只读核对或暂停（运行时从不重放）、脚本批准、浏览器权限、敏感字段授权、`pauseReason=user` 的提问。

## 等待与核对

- `check` 保存 operationId、expected、deadline、kind、dispatch 和完成说明。deadline 是绝对时间，恢复后不延长；停止、补充指令、清空记忆会作废旧检查。
- 字段动作（fill/check/select）自动添加值/勾选条件。`field_equals` 与 `text_present` 先精确比较，不符时再忽略编辑器改写的空白（NBSP、CRLF、连续空格、空行）比较。
- 纯延时：kind=delay、expected 为空；到期记 `DELAY_ELAPSED` 后必须重新观察，不检查网页条件。
- `check.dispatch` 在执行前为 unknown，拿到回执后更新；只读核对不覆盖它。旧检查点缺省按 unknown。

## 错误与恢复

| 情况 | 处理 |
|---|---|
| 网络错误、25 秒超时、429/5xx | 最多额外重试 2 次，每次计轮数 |
| `MODEL_PROTOCOL_FALLBACK`（auto 下接口不支持原生工具调用，未执行任何动作） | 与上行共用 2 次重试额度，下一轮改用 JSON 协议，记 `dispatch=not_sent`，计轮数 |
| 模型响应异常（`MODEL_OUTPUT_TRUNCATED`、`MODEL_OUTPUT_REFUSED`、`MODEL_TOOL_CALL_UNSUPPORTED`、`MODEL_TOOL_CALL_MULTIPLE`、`MODEL_TOOL_CALL_INVALID`、`MODEL_TOOL_ARGUMENTS_INVALID`、`MODEL_TOOL_CALL_MISSING`（native 模式）、`MODEL_TOOLS_UNSUPPORTED`、`MODEL_FINISH_UNSUPPORTED`、`MODEL_CONTENT_UNSUPPORTED`、`MODEL_OUTPUT_EMPTY`、`MODEL_OUTPUT_TOO_LARGE`、`MODEL_RESPONSE_INVALID`） | 停止本轮，不修补、不自动重试，记 `dispatch=not_sent` |
| 目标过期（STALE） | 最多两次重新观察规划，然后暂停 |
| 点击被遮挡（`TARGET_BLOCKED`，未派发） | 最多两次重新观察规划；模型按回执中的遮挡层 `key` 先关闭或完成遮挡层 |
| 动作核对到期仍未核实（not_satisfied 或 unknown） | 最多两次回到 observe（`recovery=replan`，`CONDITION_TIMEOUT`），结果照实记录，运行时不重发；成功核对后计数清零，继续/补充指令/选择也清零。unknown 或非字段动作记入 `uncertainClicks`；字段值明确不符时模型可重写 |
| 完成条件或 wait 条件未核实 | 暂停；目标模式下按上一行重新规划 |
| 页面加载/忙碌 | 最多等 30 秒或沿用更早 deadline；地址一致、无 pendingUrl、readyState 为 interactive/complete 即可只读核对 |
| 最近 3 条结果同动作、同目标 label 且 code 均为 `NO_CHANGE` | 暂停（目标模式 6 条） |
| `INPUT_CANCELLED`、`INVALID_FIELD_VALUE`、`UNSUPPORTED_EDITABLE` | 暂停（reason=input），不重放 |
| 权限不足、受保护页面 | 暂停；其他错误标 failed |
| run_script | 本轮不可用则暂停为 access；商店包暂停为 script_approval，见 [脚本批准](#脚本批准)；开发版直接执行 |
| request_sensitive_access | 暂停为 sensitive_access，等待可信侧栏确认；确认后轮换代次，重新观察；拒绝保留屏蔽并暂停，不占自主恢复次数 |
| 普通阻碍导致模型请求暂停 | 最多追加 3 次重新规划 |

以上次数在 [目标模式](#目标模式) 下放宽。

未确定动作按原文档 + 节点 key（缺失时用语义描述）记入 `uncertainClicks`（最多 2 条），覆盖点击、键鼠输入和 fill/check/select，防止重新规划后重复执行；目标模式下不拦截。

## 用户命令

- **发送**：只有无任务、completed、ended 时新建；否则追加补充指令（单条 ≤ `inputChars`，总长 ≤ max(12000, inputChars × 6)，超限拒绝），取消旧请求、轮换 token、清除 pending/check 并重新观察。当前页来源必须等于任务当前来源；`scope_changed`/`permission_denied` 下仍有未确定操作时，须先点继续核对。
- **停止**：AbortSignal 传到后台 fetch；已发出的 DOM 事件不能撤销。停止不等于结束。
- **接管**（`task:takeover`）：取消请求、轮换 token、暂停为 `user_takeover`，清除 pending/check/读取范围；正在执行或核对的目标先记入 `uncertainClicks`。继续时重新观察，保留 taskId 和剩余预算。
- **结束/清空**：结束后不能用继续复活；清空删除当前任务及其来源分区。
- **脚本批准**（`task:script-approval`、`task:script-revoke`，仅可信侧栏）：见下节。待批准期间「继续」被拒绝，须先批准或拒绝。

## 脚本批准

商店包中模型返回 run_script 时不执行，任务暂停为 `script_approval` 并保存 `scriptRequest`：`{id, code, world, url, origin, documentId, snapshotId, reply, time, pending}`（pending 为执行所需的完整待执行记录）。

- 消息：`{taskId, requestId, allow, scope}`，scope 为 `once`（缺省）或 `task`，`task` 只能与 allow=true 同用；后台先校验字段类型与枚举（否则「脚本确认无效」），只接受可信侧栏发送者。
- 校验与 `task:sensitive-access` 相同：taskId、requestId 匹配，任务仍为 paused/script_approval，allow 为布尔值，否则「脚本确认已过期」。通过后取消旧请求、轮换 token、清除 `scriptRequest`。
- 拒绝：结果记 `SCRIPT_REJECTED`（dispatch=not_sent、recovery=replan），任务回到 running 并重新观察，模型改用其他方法。
- 批准：当前标签、URL 与来源须与请求一致，否则记 `STALE` 不执行（scope=task 也不授予）；一致则 phase=approved。下一 tick 再核对标签和 URL，写 executing 检查点后执行该代码一次（执行前另核对文档 ID）。worker 在 approved 阶段重启会执行这一次；进入 executing 后中断按结果不确定暂停，不重放。
- 本任务内允许（scope=task）：另在任务记录写 `scriptApproval={scope:'task', origin, tabId, grantedAt}`。之后模型返回 run_script 时，在存储写入的同一步核对授权仍在且 `tabId`、`origin` 与当前执行标签和快照来源一致，一致则不暂停，直接按普通路径（pending → executing 检查点 → 文档 ID 核对 → 执行一次）运行，请求连同完整代码记入结果；不一致则丢弃授权并照常暂停批准。同来源的新文档（刷新、站内跳转）保留授权。
- 授权清除：侧栏「撤销」（`task:script-revoke {taskId}`）、结束任务、清空、新建任务、切换来源（`switchOrigin` 重建记录）、切换执行标签（`switchTab` 置空）、`userScripts` 权限被移除（`permissions.onRemoved` → `reviewPermissions`，以及每轮检测到无权限时）。停止、接管、补充指令不清除授权（任务仍可继续，侧栏一直显示撤销入口）。撤销不影响已写入 pending 的这一次执行。
- 作废：停止、接管、补充指令、结束、导航（暂停中导航记 `script_stale`）、页面加载、执行标签关闭都会丢弃待批准请求或未派发的已批准执行，结果记 `SCRIPT_DISCARDED`（not_sent）。
- 开发版（`PageAgentDevFlags.autoApproveScripts`）跳过本节，直接走普通执行路径，不显示批准卡片。

## 子目标

模型普通响应可附 `subgoals`，在同一轮更新 `taskPlan`，不额外请求模型：

- 每项 `{id, title, status, checks?}`；status 为 pending/active/completed/blocked；id 为 1–40 位字母数字或 `_`/`-`，title ≤ 120 字符；每次最多 8 项更新、最多存 8 项；同 ID 替换，`[]` 清空。拒绝额外字段，不保存私有思维链。
- completed 必须带 1–5 个条件，按本轮规划快照核对；不满足则降为 active。核对的是规划时的页面，不是后续动作效果，也不能替代 done 的完成条件。
- 记忆变更时 `taskPlan` 清空，并删除结果/归档/检查点请求中的 `subgoals` 元数据（不删除动作、expected、deadline、dispatch）。

## 导航与任务范围

- `navigate`：复用动作检查点，自动绑定 `url_equals`；后台只派发一次，回执不明则只读等 URL，worker 恢复不重发。
- 范围修改（`changeOrigins`，仅可信侧栏）：核对 taskId/scopeRevision，新增来源须已有主机权限；成功后 abort、取消调度、轮换 token、暂停为 `scope_changed`，清空读取范围、摘要、usage 锚点、计划和问题，保留结果与未确定检查点。
- 浏览器 `permissions.onRemoved` 触发复核，只暂停缺少当前主机权限的任务（`permission_denied`），不改范围。
- 上述暂停保留 executing/check；继续时按原条件和 deadline 只读核对，不重放。

## 跨来源切换

每次 turn 先读浏览器 URL。来源变化时 `adoptOrigin` 校验主机权限；通过核对后自动记录目标来源，不要求预先加入任务：

- 原操作只有 URL 条件且实际 URL 满足：只读核对后切换。无条件的 executing、旧 DOM 条件或未预期重定向：暂停并保留 check/deadline/dispatch，不在新站点评估旧字段。
- URL 变化或主文档开始加载触发 `navigationChanged`：取消旧模型/摘要请求并轮换 token。
- 切换由 `task-store.switchOrigin` 单独发布：新根只保留用户目标与补充、taskId、预算与累计统计、授权目录；结果、摘要、归档、计划、完成条件、笔记读取全部重新开始。旧来源内容存入只读来源分区，模型看不到；返回旧来源也不恢复，只恢复该来源的未确定点击约束。

## 记忆版本

- 每次观察读取当前 origin 的网站笔记目录和全局目录及版本；版本变化则清理旧摘要和读取缓存，模型返回后再核对一次，变化即丢弃计划。
- 用户修改网站笔记：取消同站请求，暂停同站运行任务。修改全局笔记：取消所有站点请求，暂停各活动任务。两者都保留等待期限和 executing 检查点，继续时先只读核对。
- 补充指令设置 `memoryReview` 提醒，成功写入笔记或用户手动修改记忆后清除。

## 多标签执行

任务同一时间只有一个执行标签页（`tabId` = `activeTabId`，即 binding 所在标签）；观察、动作、核对、指针都只作用于它，其他成员不读取、不注入。

- 模型输入：成员多于 1 个时附 `tabs`（仅本任务仍打开的成员：tabRef、kind、active、origin、≤ 80 字符标题），放在 page 前；标题按不可信网页数据处理。
- `tab_switch`：tabRef 必须在目录中、不是当前执行标签、浏览器确认仍打开且为 HTTP/HTTPS，否则返回 not_sent 错误结果（`TAB_NOT_MEMBER` / `TAB_ALREADY_ACTIVE` / `TAB_CLOSED` / `UNSUPPORTED_PAGE`）交给模型重新规划。通过后在队列内 abort 旧请求，`store.switchTab` 轮换 token 与 scopeRevision，清 pending/check/读取范围，不重置轮数，不激活浏览器前台。迟到回复因 token 与 binding 均已变化而丢弃。
- 目标标签来源不同：下一轮照常走 [跨来源切换](#跨来源切换)（主机权限、来源分区、上下文清空）；缺少权限则暂停为 `permission_denied`，不读取目标页。
- `tab_open`：先查目标主机权限（缺少则暂停为 `browser_target`，不创建），成员已满 8 个则拒绝；写 executing 创建意图后调用一次 `tabs.create`（后台、opener 所在窗口）。用浏览器返回的 tabId 登记为 task_created 成员（停止后仍登记，避免无主标签），再切换执行目标到新标签。`tabs.create` 失败或回执不明 → 暂停 `uncertain`；worker 在执行中重启 → 按现有 executing 规则暂停。从不重试、不按 URL 或标题认领。
- `tab_close`：只接受非执行中的 task_created 成员，且其当前来源仍在 `allowedOrigins`（被用户导航到别处的不关）；写 executing 后调用一次 `tabs.remove`，再向浏览器确认已不存在才移出目录，仍存在则返回 `TAB_STILL_OPEN`，不重试。

## 成员关闭

`tabs.onRemoved` → `runtime.memberClosed(tabId)`：

- 执行标签页、仍有其他打开的成员：立即 abort，取消调度，把绑定移到第一个仍打开的成员（目录顺序）并暂停为 `active_tab_closed`；进行中的动作检查点记为 unknown 结果（`TAB_CLOSED`）并加入 `uncertainClicks`，不在新标签核对旧条件，不重放。completed/stopped/failed 保持原状态。
- 执行标签页且无其他打开成员：`store.closeMember` 归档为 ended/`member_closed`，保留 pending/check 作为未知证据，释放所有成员；迟到回执不能回写或重新派发。
- 非执行成员：只从目录移除（`changeMembers` closed），任务状态、token 与预算不变。
- 启动 recover 先取浏览器标签 ID 清单，缺失的执行标签页和成员走同一路径；清单查询失败则不推断关闭。

## 成员目录

- `members(tabId, taskId)`（仅可信侧栏）：返回成员目录（tabRef、类型、是否执行中、是否打开、当前 origin、≤ 80 字符标题、是否在任务范围）和可加入的 HTTP/HTTPS 标签页（≤ 50，标记是否被占用）。
- `changeMembers`：核对 taskId 与 membersRevision；加入前向浏览器确认标签仍打开且为 HTTP/HTTPS；可移出除执行标签页外的任意成员，移出不关闭网页。
- 侧栏命令（get/stop/takeover/resume/finish/choose/approve/成员/范围/诊断/清空）从非执行成员标签发出时，后台经 `runtime.resolve` 作用于其任务的执行标签页；历史与记忆仍按发出标签。发送：所属任务未结束时作为补充指令；已结束（或非浏览器对话已完成）时先释放该标签（`release`），再在此标签新建任务。

## 诊断

- 模型、摘要、工具派发统一计时：`metrics.timings.{model,summary,tool}` = attempts/completed/failed/totalMs/lastMs。completed 只表示调用返回，不代表业务成功；attempts−completed−failed 为中断未回报次数。停止后的迟到结果不补写。
- `task:diagnostics` 需 tabId/taskId 且当前页来源与任务一致；按固定字段重建 `page-agent-diagnostics` v1 报告：状态/阶段、轮数、metrics、timings、保留结果的工具与 V2 状态分布。不含任何标识、URL、目标、正文、笔记、错误文本；未知工具名不输出。读取不修改存储。
