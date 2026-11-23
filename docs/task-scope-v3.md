# 任务站点集合与标签归属设计（PA7/PA8）

状态：分阶段设计。V3 单成员 root/registry 与中断对账基础已实现，实际字段见 [存储说明](storage.md)；任务级运行资源已迁移；UI 已解除旧键镜像依赖；成员关闭适配、多成员/跨 origin 工具仍待实现，本文后续目标不是运行时能力声明。保持现有单标签/同 origin 任务。当前 navigate 仅支持同源；完整扩展 stub 已验证的范围见 [测试说明](testing.md)。本方案不依赖新进程、构建或运行期注册代码。

## 设计起点（V3 根记录迁移前）

- `task-store.js` 的 `task:tabId` 是任务主记录，历史和临时记忆也从 tabId 入口访问；长期网站笔记按完整 origin 保存。
- `runtime.js` 的锁、请求控制器、tick 和调度均按 tabId；`background.js` 的 `task:tabId` alarm 与 tabs.onRemoved 会移除该标签任务。
- `browser-tools.js` 的 navigate 校验同 origin，并通过内容脚本消费当前 documentId/snapshotId 后一次 tabs.update。条件 URL 校验同样限制当前 origin。
- 因而不能仅放宽 URL 检查或更改 task.tabId，否则会重置预算、清错独立任务、复用旧目标或把旧网站笔记带到新网站。

## 授权及界面

权限与任务范围是两个独立条件，执行须同时满足浏览器可访问权限及用户给该任务的成员/站点授权。

1. 新任务默认只含初始标签页及完整 origin。`https://a.test`、HTTP、子域和不同端口分别授权，不支持通配 task origin。
2. 侧栏任务范围面板由用户明确添加 HTTP/HTTPS origin；需要主机权限时，只能从该用户手势调用 permissions.request。已有全站权限不自动把网站或标签页加入任务。模型不能授权，网页/笔记不能扩大范围。
3. 加入现有标签必须用户在范围面板选定并确认；先展示站点、标签类型和其他任务占用状态，不自动枚举全浏览器标题/URL给模型。只显示允许用户管理的候选项，不把 API key/配置发给页面。
4. 用户可从任务移除成员、撤销 task origin 或撤销浏览器权限。撤销立即取消受影响请求；正在处理的副作用仍可能生效，不假称撤销成功或自动重做。移除成员不关闭网页。
5. “停止”“我来操作”“继续”“结束”作用于整个任务，侧栏显式显示当前执行标签与已授权站点；手动在浏览器激活其他标签不会自动接管它。

## 数据模型与一致性

单成员基础已将任务主记录迁至 session `taskRoot:taskId`，元数据索引为 `taskRegistry`；下表为后续多成员的完整目标模型，实际单成员实现及旧版迁移见存储文档。不使用 local/IndexedDB 模拟跨重启恢复。长期笔记数据库保持现有职责。

| 字段/记录 | 责任 |
|---|---|
| taskRoot.version=3、taskId、token | 任务身份及运行代次，切换不换 taskId |
| initialTabId、initialOrigin | 不变的创建来源，仅作用户记录，不作为当前 DOM 来源 |
| activeTabId、activeOrigin | 本次执行目标；URL/origin 每次重新向浏览器核实 |
| allowedOrigins | 用户显式授权的完整 origin 集合，模型只读 |
| members | tabId、opaque tabRef、kind=initial/user_joined/task_created、joinRevision；不保存 DOM ID |
| pending/check | operationId、activeTabId、origin、documentId、snapshotId、token、原 deadline、scopeRevision、dispatch |
| steps/prefs/context | 仍归任务，不按标签复制或重置；模型及摘要均累计一轮 |
| taskRegistry | revision、tabOwners(tabId→taskId)、任务元信息/成员归属；不包含目标、正文、笔记或完整历史 |
| memory:tabId | 继续按 tabId 和完整 origin 隔离；网站笔记读取 activeOrigin，全局笔记沿用独立作用域 |

storage.session 的多键写入不作为事务假设。所有成员归属变更走后台全局短串行队列，任务执行走 taskId 队列；不能持有全局队列等待模型/网络。taskRegistry 是成员唯一归属的权威，taskRoot 是执行状态的权威，执行须两者 revision/成员匹配，否则暂停修复，不能“挑一个看起来较新”的执行。

成员变更分三步：先写 registry 的归属/修订及变更意图；再写带对应 scopeRevision 的 taskRoot；两者一致后清意图并允许执行。中断后按 registry 意图只读检查 root/浏览器状态，修复到暂停态；不派发页面或标签副作用。执行前再次核实绑定版本及 token。发生配额/写失败保留旧任务与意图，暂停并提示，不默默丢失成员或重建任务。

一个标签最多归一个未结束任务。已被其他任务占用时拒绝加入，不隐式抢占、合并或停止其他任务。已结束任务的历史不占用活动归属；用户加入新任务不覆盖旧历史。tabRef 是当前任务内目录引用，只能从刚读到的任务目录使用，不接受任意 tabId。

## 切换与工具边界

后续静态工具沿用现有严格 JSON/V2 结果，具体参数实现时同步注册表和文档；本节不是当前可调用协议。

| 工具方向 | 约束及核对 |
|---|---|
| task_tabs | 仅列当前任务仍存在且可访问的成员，返回短 tabRef/当前站点与有限标题；不列无关标签 |
| tab_switch | 仅切换已加入成员；取消旧模型/摘要/等待轮询，更新 token 与 scopeRevision，清旧 DOM/读取范围，观察新页；不会重置 steps |
| tab_open | 仅用户授权 origin 的明确 URL；先记录创建意图，成功后登记 kind=task_created；创建/登记中断则只读对账，不能再次创建 |
| tab_close | 初始/用户加入的标签一律不能由模型关闭；只允许仍属本任务的 task_created。活动标签关闭前须先明确切到另一存活成员，否则暂停请用户选择 |
| navigate | 目标 origin 须在 allowedOrigins 且具备主机权限；保留一次性快照消费及 executing 检查点；跳转后重新观察，不能复用其他标签/文档目标 |

tab_switch 的执行目标与浏览器前台激活分开。默认只改变任务 activeTabId，不强制抢用户前台；若将来需要激活，应由明确用户偏好控制，不能靠模型字符串暗示。

切换前若旧操作仍在 executing/waiting verification，先核实或暂停，不把切换当成该操作失败。保留带原标签/documentId 的未确定操作记录，不能把旧 expected 在新标签求值。未确定副作用默认不允许自动 tab_close；不得通过关闭页面绕过核对。

## origin 与上下文

- 每个网页结果、归档批次、站点记忆读取及临时记忆读取需标记 origin 与 tabRef；不得用成员的初始 URL 代替当前 URL。
- 切换 origin 时取消旧请求、清空站点摘要/usage 锚点/读取范围，移除旧站点笔记正文及记忆读取结果，再装配新 origin 的目录；全局笔记仍按需读取。旧网站笔记不能自动晋升为全局笔记。
- 首版模型只接收当前 origin 的页面/站点结果，用户原目标与用户补充可在任务内共享；跨站交接只保留用户明确提供的信息及有限公开子目标，不自动携带旧表单值、笔记正文或旧 DOM ID。来源不能确定的旧计划/摘要清空并重新规划。
- 历史按任务内 origin 过滤提供只读视图，用户界面可展示任务站点目录，但不能在未授权 origin 上读取旧正文；统计导出继续仅固定数字/枚举，不含成员 URL/标题/标识。
- url_equals/url_changed 必须绑定原操作标签和任务 scopeRevision；跨站 URL 不能仅靠放宽 conditions.js 的同源检查实现，授权集合检查须在可信后台完成。

## 事件、撤销和恢复

| 事件 | 所需处理 |
|---|---|
| activeTab 导航到允许 origin | 等待 DOM 可读，按新文档观察；来源变化取消旧请求，预算及原期限不变 |
| 重定向到未允许 origin / 内部协议 | 停止注入/读取/执行，暂停显示访问边界；权限弹窗只能由用户范围面板发起 |
| 浏览器权限撤销 | 取消任务请求并暂停受影响任务，清理工具连接/显示层；不重播未知动作 |
| 非活动成员关闭 | 只删该成员，保留主任务及其他独立任务 |
| 活动成员/初始标签关闭 | 取消请求、暂停整个任务；仍有成员时保留 root，要求用户选择后新观察；无成员则 ended，不删除其他任务 |
| 停止/接管/替换任务 | 任务级 token 隔离，取消所有该任务请求/定时器；旧成员迟到回复无权覆盖新任务 |
| worker 终止 | 以 taskId 恢复调度；executing 的导航/打开/关闭仅查浏览器现状，不重新派发，deadline 不延长 |
| 浏览器重启 | session 不保留任务；不从长期笔记/历史自动重建运行任务 |

alarm 迁至任务 ID，onUpdated/onRemoved 先查成员权威索引；不能继续调用 runtime.remove(closedTabId) 删除整个任务。用户另行开始的独立任务仍有独立 token/控制器与预算。

打开新标签时先存 create intent 并使用浏览器返回 tabId 登记。若 tabs.create 回执丢失，没有可靠创建结果身份，暂停请用户核对，不按 URL 自动认领已有标签；同 URL 不能证明所有权。关闭回执丢失仅查询成员是否仍存在，存在也不能自动再关。task_created 标签被用户导航后仍保留所有权标记，但新 origin 未授权时不可操作或自动关闭。

## 兼容迁移与实施顺序

1. 先引入 taskId 根记录、registry 与只读对账，保持单成员行为；旧 V2 task:tabId 迁移为 allowedOrigins=[旧 origin]、initial 成员，保留 token/steps/deadline/未知执行状态。不得自动获得新站点或标签。
2. 新 root 和 registry 校验一致后再移除旧主记录；失败保留原记录并暂停。原 tab/origin 历史及临时记忆不批量改源；旧待执行动作只能只读核对或暂停。
3. 将调度/控制器/锁/事件改为 taskId，跑完整旧单标签回归；此阶段仍不开放跨站或多标签工具。
4. 实现用户任务范围面板及撤销，先开放单标签跨已授权 origin 的 navigate；核对目录/摘要清理、重定向、预算与恢复。
5. 再开放用户加入、任务成员目录及 switch，最后实现 task_created 的 open/close 和丢回执对账。

每个阶段独立实现、测试、文档与 commit；未通过相应边界测试的工具不写成已实现。无需为此阻塞既有 V1 其他验收，也不把设计文档视为用户已授权任何真实站点/标签。

## 验收矩阵

以下均待执行，不是已通过记录。

| 场景 | 关键断言 |
|---|---|
| 全站浏览器权限，任务只有 A | 请求 B 仍拒绝，未读 B 内容、未注入、不增加授权集合 |
| 用户授权 A/B，A→B→A | 同一 taskId/累计轮数，三次新观察，网站笔记/临时记忆不串源 |
| 两个独立任务，抢占对方标签 | 拒绝加入，对方状态/请求/预算不变 |
| 同名/同 URL 的用户标签与新标签 | 只认已登记 tabRef；不按 URL 猜所有权，不关闭用户标签 |
| 切换时旧模型/摘要/等待迟到 | token/scopeRevision 拒绝，旧 ID 不落到新文档 |
| tabs.create/update/remove 回执丢失 | 操作计数最多一次；只读对账或暂停，不重新创建/跳转/关闭 |
| 创建意图/registry/root 写入间 worker 终止 | 对账暂停，无多重归属、无重置预算或自动副作用 |
| active 与 inactive 成员关闭 | 主任务保留/暂停策略明确，不误删其他任务 |
| 允许导航重定向到 C 或权限撤销 | C 内容不读取，任务暂停，不自动申请权限 |
| 源站旧笔记/摘要含 fixture 敏感标记 | 新 origin 模型输入无该标记，用户清空后不能由归档恢复 |
| 配额失败及 V2 迁移失败 | 原记录与未确定检查点保留，不能出现双运行任务 |

测试层级：Node 假时钟/存储故障/取消；真实 MV3 + 本机 stub 的两 origin 服务、可计数标签操作与 worker 故障注入；最后另做原生授权面板/用户手势和真实模型人工任务。分别记录请求数、重复副作用、人工介入及不支持场景，不以 stub 通过替代完整验收。
