# 存储与升级

| 位置 | 内容 | 生命周期 |
|---|---|---|
| local config | API、模型、密钥、语言 | 本机保留，不同步 |
| local agentPreferences | maxSteps、contextTokens、compressionThreshold | 默认 50 / 100000 / 80，保留已有预算；旧 autoFill/autoClick 忽略，下次保存移除 |
| local welcomeImage | 自定义侧栏主图 PNG data URL，null 或缺省为内置图 | 本机跨重启保留，恢复默认时写 null；不进入任务/模型上下文 |
| local sites | 文章持久化站点 | 本机保留 |
| local savedPages | 文章记录 | origin + pathname + search，忽略 hash |
| IndexedDB page-agent-memory / sites | 按完整 origin 保存长期笔记和版本 | 本机跨重启；用户删除或卸载/清理存储后消失 |
| IndexedDB page-agent-memory / global | 独立 scope=global 记录，全局偏好和通用经验及版本 | 本机跨站/任务/标签页/重启共享，不同步 |
| session task:tabId | 旧版迁移记录（不再双写） | 成功迁移/核对根记录后删除 |
| session memory:tabId | 按 origin 保存的临时笔记 | 模型决定维护；任务结束保留，清空任务或关标签删除 |

API 初始化强制 local 为 TRUSTED_CONTEXTS；缺少该 API 拒绝初始化，不降低密钥隔离要求。session 默认仅可信扩展上下文访问。

`welcome-image.js` 仅在设置页和侧栏加载，直接读写独立的 welcomeImage key，不读取 config。设置页接受 PNG/JPG/WebP（5 MB、边长最多 8192），浏览器解码后通过 canvas 等比缩小至最长边 1024，再编码为 PNG；存储字符串最多 2 MiB。拒绝 SVG 与网络地址，失败不覆盖已保存值；监听 local 变化同步预览，读取代次避免迟到初始读取覆盖新值。侧栏以固定容器等比显示，解码失败回退内置图。该存储与权限隔离沿用现有 TRUSTED_CONTEXTS。

任务由后台写入，侧边栏发命令并监听变化。字段包括 version、taskId、token、tabId、origin、goal、instructions、status、phase、steps、prefs、pending、results、events、updatedAt、retries。instructions 为带时间的用户补充指令，旧记录缺省为空。pending 只有计划和快照标识，不含可重建 DOM 引用，文档替换后不能重放。

session 可能在浏览器重启、扩展更新、重载或禁用后清除。它不是跨重启持久任务；local 也不是加密保险箱。

任务 V2 增加 check、waitDeadline、completionChecks、completionEvidence、lastOutcome、metrics、recoveryCount。迁移补齐缺省字段；保留旧 executing 阶段，不自动重放。check 仅保存受限条件与语义描述，没有 DOM 节点或脚本。等待沿用已存截止时间。

任务内摘要使用可选 contextSummary={content,through,updatedAt}，旧任务缺省为空，无需重置或改版本。摘要成功后与 results 裁剪一起写入同一 task key；compacting 中断保留旧结果，可重新整理。摘要不跨任务或浏览器会话。

contextArchive 同任务保存压缩前结果，含 id/from/to/results；上限 100 万字符，当前任务清空时删除；任务替换时随旧对话保存为只读历史。contextUsage 保存 API token 用量、估算基准及服务路由配置散列，不含密钥明文。contextPressure 是最近判断值，compactionGuard 防止无效连续压缩。旧任务缺省字段为空。

## 旧版迁移

初始化扫描旧 chat:tabId。有目标且无新任务时迁移为暂停状态，保留目标、原站点和累计轮数。不迁移待执行动作，不自动调用模型；成功后删除旧 key。配置和文章记录保留，已有站点注册升级脚本列表。

## 后续

完整消息、动作轨迹与检索可迁移到 IndexedDB。偏好、站点经验、技能需独立 schema、来源、更新时间及删除入口。已实现网站和全局长期笔记；完整历史检索、同步和备份导入未实现，见 [上下文与技能](context-and-skills.md)。

## IndexedDB 网站笔记

`site-memory.js` 原生 IndexedDB，无额外权限、库或构建。数据库 page-agent-memory 版本 2（从版本 1 升级保留 sites 原记录），sites 对象仓库以 origin 为主键，记录 {origin,version,notes}，笔记含 id/text/source/createdAt/updatedAt。单站 32 条/64000 序列化字符、单条 2000 字符；总存储受浏览器配额约束，不申请 unlimitedStorage。

readwrite 事务在读取版本后写入；不匹配返回 MEMORY_CONFLICT。成功完成事务才返回保存成功；失败/abort 不修改旧记录。clear 保留空记录与递增版本，防止旧请求以 version=0 把数据写回来。任务清空、关标签、重载不清长期笔记；只允许可信侧栏通过后台调用，内容脚本没有此命令权限。侧栏操作附期望 origin，导航后拒绝写入另一个网站。

手动更新前取消同站模型请求，成功后清理同站任务摘要、site_memory_* 与 history_read 缓存，更新代次并暂停运行任务。执行模型回复前重新核对网站笔记版本；其他标签页修改后旧回复丢弃。模型写入携带当轮读取版本并支持 AbortSignal。source 标注 user 或 model，仅表示写入来源，不代表事实已验证。

侧栏导出仅导出当前 origin 的笔记和 schema 标识，不包含 API 配置；导出不自动触发上传。无导入、加密、跨浏览器同步、账号级隔离、向量检索或自动记忆去重。

## 会话内对话历史（已实现）

替换不同 taskId 时，task-store 在同一次 session.set 中保存 `conversation:tabId:taskId` 并写入新的 `taskRoot:taskId`（完整发布协议见 V3 章节）；存储失败则不主动删除旧记录。普通替换归档移除 token、pending、check；成员关闭归档保留未知操作证据（见下文），不参与 runtime.list/recover，也不提供恢复执行入口。相同 taskId 的更新不额外生成对话，停止/暂停后的补充指令仍属于原对话。

历史目录只返回标题、状态、更新时间和 taskId；正文按需读取。后台仅接受可信侧栏的 task:history / task:history-get，按当前标签页完整 origin 校验。查看记录不请求模型、不改变活动任务，也不自动继承原任务上下文。关闭标签页删除其所有对话；清空当前任务不删除其他归档。继承 session 的生命周期与容量限制，配额不足时创建新任务可能失败，不静默裁剪旧历史。

保留的是任务已有的滚动消息、工具结果、摘要与 contextArchive；不补齐此前已被裁剪的状态消息，不是完整无限轨迹，也不能恢复功能上线前已被覆盖的对话。暂不支持跨标签页历史列表、跨重启保存、搜索、导入或逐条删除归档。

## 全局长期笔记

同一数据库独立 global 对象仓库以 scope 为主键，唯一记录 {scope:'global',version,notes}，不使用虚拟 origin。笔记字段与每范围 32 条/64000 序列化字符、单条 2000 字符上限沿用网站笔记；独立版本和 readwrite CAS 保证原子性。clear 保留递增版本的空记录。

只有可信设置页/侧栏可通过后台 task:global-memory 与 task:global-memory-change 管理，全局管理无需 tabId；内容脚本被拒绝。模型使用 global_memory_* 工具，每轮只看到 globalMemoryIndex，正文按需读取。用户修改前取消各站请求并暂停现存活动任务，清理全局读取结果、history_read 缓存及摘要；等待期限和 executing 检查点保留，继续时先恢复只读核对。模型写入使其他在途决定失效，后续按 globalMemoryVersion 重读。网站和全局分别清空/导出，不包含 API 配置。无同步、导入或账号隔离。

正文分段读取沿用 task.results，保存 text、textRange 和 untrusted 标记；无新增存储键或恢复游标。普通上下文归档/压缩规则适用，不跨重启恢复。

任务可选 nextObservation={value:{elementOffset?,query?,regionOffset?,regionQuery?},url,documentId} 是一次性只读范围，不存 DOM 引用或待执行动作；旧任务缺省为空。下一 tick 消费，运行代次改变时清空；只存在 session，不跨浏览器重启恢复。

动作 check 可选 dispatch 保存原动作的 sent/not_sent/unknown，执行前初始化 unknown，取得回执后更新；只读核对不覆盖。旧记录没有此字段时按 unknown，不推断从未执行。

用户接管使用现有 status=paused、reason=user_takeover 和 uncertainClicks 存储，不新增持久键；pending/check 清除前，将执行中或核对中的目标记为未确定，恢复不重放。接管记录仍仅限浏览器会话。

nextObservation.value 可选 includeText 布尔值，用于一次性的正文省略；未读标记保留在本轮快照，不新增存储键或持久页面缓存。

任务可选 taskPlan 数组（默认空）保存 PA6 公开子目标、验证结果、记录时间及文档来源；沿用 session task 和只读对话归档，不新增数据库，不跨浏览器重启恢复。验证证据是历史数据，不是待执行检查点或动作，恢复先重新观察。

同源 navigate 不改变任务归属或权限模型；pending.plan.value 是受限绝对 URL，check 保存自动 url_equals 和原 deadline，session 检查点恢复只核对不重复导航。原 origin 隔离、重启不恢复任务不变，尚无授权 origin 集合或多标签任务结构。

记忆失效时 taskPlan 清空，当前 results/contextArchive 中 request.subgoals 及 pending.plan/check.request.subgoals 移除；仅删除计划元数据，不删除待核对动作、expected、deadline 或 dispatch。已归档对话的只读历史沿用既有保留规则，不重新作为当前任务模型输入。

nextObservation.value 可选 regionTextOffset，必须配合 regionQuery；仅保存下一轮的受限文字偏移，不缓存区域正文或 DOM 引用，文档/代次边界仍使范围失效。

metrics.timings 可选 model/summary/tool 分组，分别保存 attempts/completed/failed/totalMs/lastMs；旧任务缺省无计时。仅会话内累计，归档沿用当前对话历史规则，不保存正文、密钥或额外请求 URL；中断未完成次数可由计数差推导，lastMs=null 表示尚无回报。

诊断统计 JSON 为用户点击时从现有 session 记录只读生成，不增加存储键或自动落盘；仅当前任务且 origin/taskId 匹配。文件不包含任务/标签标识、URL、令牌或自由文本，不能导入恢复。

## 跨站/多标签任务设计（未实现）

下一步根记录、成员索引、修订一致性、迁移及配额失败恢复见 [任务站点集合与标签归属设计](task-scope-v3.md)。已实现下文 V3 单成员 root/registry，调度仍按 tabId；设计中的 session 多键更新不假设事务，执行前须索引/根记录一致。不得仅改 tabId 或放宽 origin 验证开放标签工具。

## V3 单成员根记录（已实现基础）

任务主记录为 session taskRoot:taskId，version=3；taskRegistry={version:1,revision,bindings:{tabId:{taskId,revision}},pending?} 为单成员归属权威。根记录 scopeRevision 须与 binding 对应；同一 taskId 不可归属两个标签。当前 root 固定 initialTabId=activeTabId=tabId、initialOrigin=activeOrigin=origin、allowedOrigins=[origin]，members 只有 kind=initial/tabRef=tab0 一项，写入不会接受调用方扩大范围。

现有 store.get/set/history/list(tabId) 接口保留；task:tabId 仅为旧版迁移输入，不再双写整份任务。侧栏监听根记录/归属索引作为失效信号，通过可信 task:get 读取当前任务，忽略旧键事件内容；pending 归属期间暂停刷新，取消迟到读取。外部直接改旧键不覆盖已有 binding 的根记录；生产后台统一经 store 写。临时记忆及 conversation 历史键仍不变。

新建/替换归属先写 registry.pending 意图，再写 root/必要历史，最后提交 binding；不假设多键写入原子性。pending 存在时读取拒绝执行（TASK_SCOPE_INCONSISTENT）。启动 migrate 先只读存储对账：新 root 已写且 revision 匹配则采用，否则回到旧 binding/旧记录；缺失的旧对话从旧 root 补归档。存活任务置 paused/reason=scope_reconciled，保留 token/steps/pending/check/deadline/dispatch，用户继续只读核对。故障持续时保留现场，不自动重建任务或扩大站点。

同一成员普通检查点更新不改变 scopeRevision，根记录始终权威。成功发布归属后清理旧键；启动迁移在验证已有根记录后重试清理，根缺失则保留迁移证据并报错。当前 worker 同一 session 对象的存储实例共享短写队列。成功替换后删除旧活动 root；未绑定 root 不进入 list/调度，启动只清理存在归档凭据的旧 root。remove 先清遗留旧键再释放归属，避免旧记录变回运行任务。

V2 task:tabId 启动时迁移；chat 旧版仍先转为暂停任务。迁移保留任务身份/预算/未知动作，不自动新增站点/成员。tabId API 保留，单成员页面关闭改为独立终态归档（见下文），任务级调度见下文；跨站和多标签仍未实现。

任务级调度仅由 taskRegistry 已提交 binding 的 getByTaskId 解析，不扫描未绑定 root 或历史对话作为运行任务。alarm 名为 task-id:taskId，旧 task:tabId alarm 只作清理/升级；timer/控制器/运行锁为 worker 内存资源，不新增持久任务键，恢复仍使用根记录原检查点/deadline。

## 单成员关闭归档

浏览器成员关闭走 closeMember(tabId,expectedTaskId,closedAt)，不复用用户清空任务。当前严格要求唯一 initial 成员，不接受多成员数据。先写 taskRegistry.pending={kind:member_closed,tabId,binding,closedAt}；再写 ended/reason=member_closed、members=[]、activeTabId/activeOrigin=null 的终态根及 conversation 归档，去掉 token，保留 steps、phase、pending/check 和原 deadline/dispatch 作为未知动作证据；清该标签旧键/临时记忆后释放 binding，最后清理无绑定根。归档在本浏览器会话保留，不提供跨标签恢复或关闭后历史检索入口；historyGet 仍不向侧栏暴露 pending/check/token。

pending 期间读取拒绝执行；启动 reconcile 识别关闭意图，只读校验原 taskId/revision 后继续存储清理，不执行页面/模型，不把终态任务恢复运行。归档、临时记忆清理或索引提交失败保留意图；已释放 binding 的残留根由既有归档清理处理。重复或过期 taskId 关闭无操作，其他任务/历史/长期笔记不变。
