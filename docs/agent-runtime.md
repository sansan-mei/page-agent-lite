# 任务运行器

`runtime.js` 通过依赖注入使用 store、tools、siteMemory、model、summarize、identity、preferences、scheduler，不访问 DOM。`taskId` 标识任务；`token` 是运行代次，停止/替换/接管/记忆变更时轮换，旧请求的迟到结果一律丢弃。

## 状态

| status | 含义 |
|---|---|
| running | 可继续推进 |
| waiting_page | 等待页面就绪，由事件或 alarm 重试 |
| waiting_confirmation | 旧版兼容；继续时丢弃待确认动作并重新规划 |
| paused | 带 `reason` 暂停，如预算耗尽、无进展、结果不确定、`user_takeover`、`scope_changed`、`permission_denied`、`scope_reconciled`、`input` |
| stopped | 用户停止 |
| failed | 未恢复的错误 |
| completed | 模型返回 done（有完成条件时已核实） |
| ended | 用户结束或成员关闭（`reason=member_closed`）；下次发送新建任务 |

`phase`：observe、thinking、compacting、confirm、approved、executing、verifying、idle，用于中断恢复。verifying 阶段不调用模型、不重复动作。

## 浏览器对话

内部页以 `origin=browser` 和空 `allowedOrigins` 新建任务，不读取 DOM 或网站记忆，只允许回答、提问和提出 HTTP/HTTPS 导航。已有浏览器主机权限时直接导航；缺少时暂停为 `browser_target`，明确说明尚未打开、任务未完成，侧栏授权后继续。导航仍先写 executing 和 URL 核对检查点，按原 deadline 核对，不重发。进入网站后沿用任务身份与预算，并走跨来源隔离。浏览器对话的回答保留为结果，后续发送沿用对话。

## 一次 tick

1. 读取任务，核对运行代次、当前 URL 来源属于 `allowedOrigins` 且有主机权限、页面就绪。来源变化走 [跨来源切换](#跨来源切换)。
2. `executing` 恢复：有条件则只读核对，无条件则暂停；`approved` 页面已变则重新规划。
3. 普通路径：读取快照（`nextObservation` 指定的范围只用一次）；超过上下文预算先压缩（phase=compacting），否则计一轮并调用模型（phase=thinking）。
4. 模型返回后再次核对代次、URL、记忆版本，任一变化则丢弃。
5. 严格解析动作（`backend.parseChatResponse` + 动作校验）。done 有 expected 或已保存的完成条件必须核实，否则标为“模型报告完成”；pause 表示受阻未完成。
6. 网页动作前保存 `executing` 检查点，执行后保存结果并调度下一 tick。记忆、history_read 等由后台处理，不发网页。

同一任务的 tick 串行；运行锁、去重 jobs、请求控制器、timer 和 alarm（`task-id:<taskId>`）都以 taskId 为身份。tabId 入口通过标签发布队列防替换竞态；`tick(tabId, expectedTaskId)` 中的过期调度不会操作同一标签上的新任务。

## 预算

- 默认 50 轮，0 不限；每次模型请求（含失败重试、摘要请求）计一轮。翻页、跨来源、worker 恢复都保留累计轮数。
- 预算耗尽或已完成后「继续」开启新预算；停止/一般失败后继续保留剩余预算。补充指令不重置预算。
- 条件等待每 tick 只读检查一次，不消耗模型轮数。`metrics` 分别统计观察、核对、动作次数。

## 等待与核对

- `check` 保存 operationId、expected、deadline、kind、dispatch 和完成说明。deadline 是绝对时间，恢复后不延长；停止、补充指令、清空记忆会作废旧检查。
- 字段动作（fill/check/select）自动添加值/勾选条件；期限内不符或未知则暂停。
- 纯延时：kind=delay、expected 为空；到期记 `DELAY_ELAPSED` 后必须重新观察，不检查网页条件。
- `check.dispatch` 在执行前为 unknown，拿到回执后更新；只读核对不覆盖它。旧检查点缺省按 unknown。

## 错误与恢复

| 情况 | 处理 |
|---|---|
| 网络错误、25 秒超时、429/5xx | 最多额外重试 2 次，每次计轮数 |
| 模型响应异常（`MODEL_OUTPUT_TRUNCATED`、`MODEL_OUTPUT_REFUSED`、`MODEL_TOOL_CALL_UNSUPPORTED`、`MODEL_FINISH_UNSUPPORTED`、`MODEL_CONTENT_UNSUPPORTED`、`MODEL_OUTPUT_EMPTY`、`MODEL_OUTPUT_TOO_LARGE`、`MODEL_RESPONSE_INVALID`） | 停止本轮，不修补、不自动重试，记 `dispatch=not_sent` |
| 目标过期（STALE） | 最多两次重新观察规划，然后暂停 |
| 点击被遮挡（`TARGET_BLOCKED`，未派发） | 最多两次重新观察规划 |
| 点击核对到期仍 unknown | 最多两次回到 observe（`recovery=replan`），结果仍记 unknown；同一文档不重发该点击 |
| 页面加载/忙碌 | 最多等 30 秒或沿用更早 deadline；地址一致、无 pendingUrl、readyState 为 interactive/complete 即可只读核对 |
| 最近 3 条结果同动作、同目标 label 且 code 均为 `NO_CHANGE` | 暂停 |
| `INPUT_CANCELLED`、`INVALID_FIELD_VALUE`、`UNSUPPORTED_EDITABLE` | 暂停（reason=input），不重放 |
| 权限不足、受保护页面 | 暂停；其他错误标 failed |
| request_sensitive_access | 暂停为 sensitive_access，等待可信侧栏确认；确认后轮换代次，重新观察；拒绝保留屏蔽并暂停，不占自主恢复次数 |
| 普通阻碍导致模型请求暂停 | 最多追加 3 次重新规划 |

未确定动作按原文档 + 节点 key（缺失时用语义描述）记入 `uncertainClicks`（最多 2 条），覆盖点击、键鼠输入和 fill/check/select，防止重新规划后重复执行。

## 用户命令

- **发送**：只有无任务、completed、ended 时新建；否则追加补充指令（总长 ≤ 12000 字符，超限拒绝），取消旧请求、轮换 token、清除 pending/check 并重新观察。当前页来源必须等于任务当前来源；`scope_changed`/`permission_denied` 下仍有未确定操作时，须先点继续核对。
- **停止**：AbortSignal 传到后台 fetch；已发出的 DOM 事件不能撤销。停止不等于结束。
- **接管**（`task:takeover`）：取消请求、轮换 token、暂停为 `user_takeover`，清除 pending/check/读取范围；正在执行或核对的目标先记入 `uncertainClicks`。继续时重新观察，保留 taskId 和剩余预算。
- **结束/清空**：结束后不能用继续复活；清空删除当前任务及其临时记忆和来源分区。

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

## 成员关闭

`tabs.onRemoved` → `runtime.memberClosed(tabId)`：

- 执行标签页：立即 abort，再在队列内取消调度并调用 `store.closeMember`，归档为 ended/`member_closed`，保留 pending/check 作为未知证据，并释放所有加入的成员；迟到回执不能回写或重新派发。
- 用户加入的成员标签页：只从目录移除（`changeMembers` closed），任务状态、token 与预算不变。
- 启动 recover 先取浏览器标签 ID 清单，缺失的执行标签页和成员走同一路径；清单查询失败则不推断关闭。

## 成员目录

- `members(tabId, taskId)`（仅可信侧栏）：返回成员目录（tabRef、类型、是否打开、当前 origin、≤ 80 字符标题、是否在任务范围）和可加入的 HTTP/HTTPS 标签页（≤ 50，标记是否被占用）。不进入模型上下文。
- `changeMembers`：核对 taskId 与 membersRevision；加入前向浏览器确认标签仍打开且为 HTTP/HTTPS；只能移出 user_joined 成员，移出不关闭网页。
- 模型仍只在执行标签页读取和操作，成员标签页不读取、不注入；切换执行标签页与 open/close 未实现，见 [多成员任务设计](plans/task-scope-v3.md)。

## 诊断

- 模型、摘要、工具派发统一计时：`metrics.timings.{model,summary,tool}` = attempts/completed/failed/totalMs/lastMs。completed 只表示调用返回，不代表业务成功；attempts−completed−failed 为中断未回报次数。停止后的迟到结果不补写。
- `task:diagnostics` 需 tabId/taskId 且当前页来源与任务一致；按固定字段重建 `page-agent-diagnostics` v1 报告：状态/阶段、轮数、metrics、timings、保留结果的工具与 V2 状态分布。不含任何标识、URL、目标、正文、笔记、错误文本；未知工具名不输出。读取不修改存储。
