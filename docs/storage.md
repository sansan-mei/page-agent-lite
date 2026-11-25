# 存储

## 存储位置

| 位置 | 内容 | 生命周期 |
|---|---|---|
| local `config` | API 地址、模型、密钥、语言、思考强度、工具调用协议 `toolMode`（auto/native/json，缺省 auto） | 本机保留，不同步 |
| local `nativeToolsUnsupported` | auto 下回退到 JSON 的 modelIdentity 哈希（最多 8 个） | 保存 API 设置时清空 |
| local `agentPreferences` | maxSteps / contextTokens / compressionThreshold / inputChars，默认 100 / 100000 / 80 / 2000 | 保留已有值；旧 autoFill/autoClick 忽略，下次保存移除 |
| local `welcomeImage` | 侧栏主图 PNG data URL；null 或缺省为内置图 | 本机保留 |
| local `sites`、`savedPages` | 已退役文章工具的站点与记录（origin+pathname+search） | 保留，无界面入口 |
| session `taskRoot:<taskId>` | 任务主记录（version 3） | 浏览器会话 |
| session `taskRegistry` | 标签 → 任务归属索引：`bindings`（执行标签页）与 `tabOwners`（其余成员标签页） | 浏览器会话 |
| session `conversation:<tabId>:<taskId>` | 被替换或关闭的对话只读归档 | 浏览器会话 |
| session `conversation-origin:<tabId>:<taskId>:<encodedOrigin>` | 离开某来源前的只读分段（tabId 为当时的执行标签页） | 清空当前任务时删除；替换/关闭后保留只读 |
| session `task:<tabId>` / `chat:<tabId>` | 旧版记录，仅作迁移输入 | 迁移成功后删除 |
| IndexedDB `page-agent-memory`（v2）`sites` | 按 origin 的长期笔记 | 跨重启；卸载/清理存储后丢失 |
| IndexedDB `page-agent-memory`（v2）`global` | 唯一记录 `scope:'global'` | 同上 |

- local 初始化时设为 `TRUSTED_CONTEXTS`，API 不可用则拒绝初始化；session 默认只对可信扩展上下文开放。都不是加密存储。
- session 可能在浏览器重启、扩展更新/重载/禁用时清空；任务不跨重启恢复。

## 任务记录

`taskRoot` 主要字段：

| 字段 | 说明 |
|---|---|
| version=3、taskId、token | 身份与运行代次 |
| initialTabId、activeTabId、initialOrigin、origin/activeOrigin | 初始标签页与当前执行标签页（activeTabId = tabId，只能经 `switchTab` 修改）；origin 只能经 `switchOrigin` 修改 |
| scriptApproval | 本任务脚本自动批准 `{scope:'task', origin, tabId, grantedAt}`；切换来源/执行标签、结束、撤销、userScripts 权限移除时清除，新任务不继承 |
| sensitiveAccess、sensitiveRequest | 本对话敏感字段决策（allowed/denied，缺省未确认）及待确认 id/text；来源切换保留决策，新对话不继承 |
| origin=browser | 未进入网页的浏览器对话；allowedOrigins 初始为空，browserTarget 保存待授权的 HTTP/HTTPS 目标 |
| allowedOrigins、scopeRevision | 已记录的任务来源及版本；切换来源自动加入，不作为导航白名单。旧侧栏范围修改接口保留兼容 |
| members、memberSeq、membersRevision | 成员目录（≤ 8）：tab0 为 kind=initial 的初始标签页，其余为 kind=user_joined 或 task_created；tabRef 按 memberSeq 递增、不复用；membersRevision 是目录版本，与 scopeRevision 独立 |
| goal、instructions | 原目标与每条补充指令 ≤ inputChars；带时间的补充指令总长 ≤ max(12000, inputChars × 6) |
| goalMode | 目标模式开关，见 [任务运行器](agent-runtime.md#目标模式)；来源切换保留 |
| status、reason、phase、steps、prefs、retries | 运行状态与累计轮数 |
| pending | 待执行计划与快照标识，不含 DOM 引用；navigate 时 value 为受限绝对 URL |
| check、waitDeadline | 等待/核对检查点（含 dispatch、原来源/标签/范围版本、deadline） |
| completionChecks、completionEvidence、lastOutcome、recoveryCount、verificationRecoveries、helpAttempts | 完成条件与恢复计数 |
| uncertainClicks | 最多 2 条未确定动作的文档/节点 key 或语义描述 |
| nextObservation | 一次性读取范围 `{value, url, documentId}`，value 键见 [网页工具](browser-tools.md#分段读取) |
| taskPlan | 公开子目标及核对证据（历史数据，不是待执行动作） |
| results、events | 工具结果与时间线（时间线最多 40 项/16000 字符） |
| contextSummary、contextArchive、contextUsage、contextPressure、compactionGuard | 上下文压缩，见 [上下文](context-and-skills.md) |
| metrics | 观察/核对/动作计数与 `timings` |
| memoryReview、问题/选择状态 | 记忆提醒与用户决策 |

旧任务缺省字段按空处理，迁移不重放未确定动作。

## 发布协议

session 多键写入不是事务，所以归属变更（新建/替换、范围修改、来源切换、执行标签切换、成员关闭、成员目录变更）都分三步：

1. 写 `taskRegistry.pending` 意图（kind 如 `origin_changed`、`tab_switched`、`member_closed`、`members_changed`）。
2. 写新根记录及必要的历史/来源分段。
3. 提交 binding，清除意图。

- pending 存在时读取拒绝执行（`TASK_SCOPE_INCONSISTENT`）。
- 启动 `migrate` 只读对账：新根已写且 revision 匹配则采用，否则回到旧 binding；未提交的来源分段回滚。存活任务置 `paused/scope_reconciled`，保留 token、steps、pending、check、deadline、dispatch，继续时只读核对。
- 一个 taskId 只能归属一个标签。只有已提交 binding 能被 `getByTaskId` 解析；未绑定根不参与调度。
- `switchTab`：核对 taskId、token、binding revision，目标须是本任务 `tabOwners` 中的成员；新 binding 指向目标、轮换 scopeRevision，旧执行标签进入 `tabOwners`（关闭时从目录删除）。`tab_switched` 中断时：根已写为目标标签则采用新 binding 与 owners，否则保留旧 binding；两者都暂停为 `scope_reconciled`。
- 普通 `set` 不能修改 origin、allowedOrigins、initialOrigin 或成员目录（members/memberSeq/membersRevision 以存储为准）。

### 成员目录

- 一个标签最多属于一个任务：已有 binding 或已在 `tabOwners` 中的标签不能加入，也不能在该标签新建任务（`TAB_OWNED`）。task_created 成员只用 `tabs.create` 返回的 tabId 登记（`changeMembers` created）。
- `changeMembers` 只改目录和 `tabOwners`，不改 binding revision、scopeRevision、token、pending/check，所以不打断运行中的任务。意图 `members_changed` 的 tabId 为空，不阻塞执行标签页读取；对账时根记录的 membersRevision 与意图一致才采用新 `tabOwners`，否则保留旧值，均不暂停任务。
- 执行标签页任务被替换、清空或关闭时释放该任务所有 `tabOwners`；启动时清理指向未绑定任务的残留项。
- 同一 worker 中的存储实例共享短写队列。

## 对话历史

- 替换不同 taskId 时，同一次 `session.set` 写入旧对话归档和新根；写失败不删旧记录。归档去掉 token、pending、check。
- 成员关闭归档：ended/`member_closed`、members 为空、去掉 token，但保留 steps、phase、pending/check 作为未知证据；侧栏 `historyGet` 不暴露 pending/check/token。
- `task:history` 只返回标题、状态、更新时间、taskId；`task:history-get` 按需取正文，均按当前标签页和完整 origin 校验，合并该来源的只读分段与当前段，不混入其他来源；任务范围撤销后拒绝该来源历史。
- 来源分区每个上限 100 万序列化字符，超限暂停（`origin_storage`）且不裁剪原根。
- 归档只含任务已保留的消息、结果、摘要和 contextArchive，不是完整轨迹；不支持跨标签列表、搜索、导入、逐条删除。切换执行标签页后，旧标签下的来源分段不出现在新标签的历史列表。

## IndexedDB 长期笔记

- `site-memory.js` 使用原生 IndexedDB，不需额外权限；从 v1 升级到 v2 保留 `sites` 原记录。
- `sites` 以 origin 为主键 `{origin, version, notes}`；`global` 以 scope 为主键 `{scope:'global', version, notes}`。笔记字段 id/text/source/createdAt/updatedAt，source 为 user/model，只表示写入来源。
- 每个范围 32 条、64000 序列化字符，单条 2000 字符；不申请 unlimitedStorage。
- readwrite 事务读版本后写入，不匹配返回 `MEMORY_CONFLICT`；事务完成才算成功，失败不改旧记录。clear 保留空记录并递增版本，防止旧请求按 version=0 写回。写入支持 AbortSignal。
- 只有可信设置页/侧栏经后台管理；网站操作附期望 origin，导航后拒绝写到其他网站。导出只含对应范围笔记和 schema 标识。
- 不支持导入、加密、同步、账号隔离、向量检索、去重。

## 侧栏主图

`welcome-image.js` 只在设置页和侧栏加载，只读写 `welcomeImage`。接受 PNG/JPG/WebP（≤ 5 MB、边长 ≤ 8192），canvas 等比缩到最长边 1024 后存 PNG，字符串 ≤ 2 MiB；拒绝 SVG 和网络地址，失败不覆盖旧值。读取代次防止迟到读取覆盖新值；解码失败回退内置图。

## 迁移

- `chat:<tabId>`（最早版本）：有目标且无新任务时迁移为暂停任务，保留目标、站点、累计轮数，不迁移待执行动作。
- `task:<tabId>`（V2）：迁移为 V3 根记录，`allowedOrigins=[原 origin]`，保留身份、预算和未知动作；不再双写旧键。根记录确认后清理旧键，根缺失时保留证据并报错。
- 旧 `task:<tabId>` alarm 只用于清理并升级为 `task-id:<taskId>`。
