# 任务运行器

`runtime.js` 依赖注入 store、tools、siteMemory、model、summarize、identity、preferences 和 scheduler，不访问 DOM。一个任务绑定一个标签页与初始站点源，`taskId` 标识任务；`token` 标识运行代次，阻止旧请求覆盖停止或替换后的任务。

## 状态与阶段

| status | 意义 |
|---|---|
| running | 可继续推进 |
| waiting_page | 等待页面，事件或 alarm 重试读取 |
| waiting_confirmation | 旧任务兼容状态；继续后丢弃待确认动作并重新规划，alarm 不执行旧动作 |
| paused | 达到预算、离开原站点、无进展或结果不确定 |
| stopped | 用户停止 |
| failed | 未恢复的错误 |
| completed | 模型根据当前观察返回 done |
| ended | 用户明确结束，下次发送新建任务 |

`phase` 包括 observe、thinking、compacting、confirm、approved、executing、verifying、idle，用于中断恢复。verifying 阶段不调用模型或重复动作。

## 每个 tick

1. 读取任务，校验站点、页面加载状态和运行代次。
2. executing 恢复时有条件则只读核对，否则暂停；approved 检查旧 URL，页面变化则重新规划。
3. 普通路径读取快照，必要时先压缩旧记录并保存 compacting；摘要成功后下一 tick 重新观察，否则累计模型轮数并保存 thinking。
4. 调用模型。停止/被替换则丢弃结果；URL 变化则重新观察。
5. 严格解析动作。done 有 expected 或已保存完成条件时必须核实；未提供时明确为模型报告完成。pause 表示未完成但受阻；填写与点击直接自动执行，不读取旧 autoFill/autoClick 开关。
6. 执行前保存 executing；网页返回后保存结果，调度下一轮。

模型返回 memory_* 时由后台维护临时笔记，记录工具结果后进入下一轮；不点击网页、不注入完整上一任务。模型可用 wait/verify 指定条件。字段动作自动添加值/勾选条件，未核实先等待，期限内不符或未知则暂停。

同标签页 tick 不并发，更新串行。停止将 AbortSignal 传到后台 fetch；已发出 DOM 事件无法撤销。不确定操作不重放。

## 预算与恢复

默认 50 轮，0 不限；每次模型请求计一轮，包括失败重试。翻页和 worker 恢复保留轮数；预算耗尽或完成后的继续开启新预算。停止/一般失败后继续保留未耗尽预算。

check 保存 operationId、expected、deadline、kind 及完成说明；条件等待每 tick 做一次只读检查，不额外消耗模型轮数。metrics 分别记录观察、验证、动作次数；deadline 在中断恢复后不延长，停止/追加/清空记忆使旧检查失效。

操作历史达到阈值后先生成结构化任务摘要，成功后保留至少最近 6 条完整结果并归档旧结果；摘要累计覆盖位置持久化，失败不裁剪。按配置模型窗口扣输出预算后的 80% 触发，无固定条数阈值；接口用量加估算增量优先。压缩后仍高压则暂停防止反复摘要。具体阈值见 [上下文管理](context-and-skills.md)。时间线仍最多 40 项/16000 字符，不是完整历史归档。

初始化扫描 active 任务；标签页加载、页面就绪和 alarm 可唤醒。worker 睡眠期间有延迟，浏览器关闭或扩展重载可能清空 session，不能承诺长期运行。

## 错误与检查

连续过期快照最多两次重新观察/规划，随后暂停。加载/忙碌等待最多 30 秒或沿用更早的条件 deadline。标签页 loading 时先只读观察，地址一致、无 pendingUrl 且文档 readyState 为 interactive/complete 才继续核对或规划；DOM 仍解析、旧地址或待跳转均继续等待。不会因资源加载延长期限。executing 检查点在等待时保留，避免恢复后重放结果不确定的动作。网络、25 秒超时、429/5xx 最多额外重试两次，每次计预算；权限与受保护页面暂停，其他错误失败。连续三次同动作、同标签且 V2 code 为 NO_CHANGE 时暂停，文案变化不影响判断。

提交通过后台串行判断任务边界：只有无任务、completed、ended 才新建，其他状态追加补充指令并保留 ID、目标、轮数、结果和时间线。补充指令保留全部已接受内容，序列化上限 12000 字符；超限拒绝追加而不裁剪，模型按时间顺序读取，较新纠正优先。旧模型请求取消、代次更新，旧待确认动作清除并重新规划。跨源时拒绝向原任务追加，需回原站点或先结束任务。

停止不等于结束，明确结束后不能通过继续按钮复活；可发送新任务。追加指令不重置预算，已耗尽时仍需点击继续开启预算。已发出的页面事件不能撤销；新一轮等旧 tick 退出后观察当前页面。

跨站和完整计划分解仍为后续能力。

## 网站长期记忆

普通观察阶段读取当前 origin 的 IDB 笔记目录和版本。若版本与任务保存版本不同，清理旧摘要及持久笔记读取结果，再构建新请求；模型返回后再次核对版本，版本变化丢弃旧计划。site_memory_* 在后台处理，不发网页操作，写入携带版本和取消信号。

手动 editSiteMemory 接受 origin 和 expectedVersion，拒绝导航后站点不一致的编辑；取消同站所有旧请求，提交后按标签页串行清理旧上下文和等待状态、轮换 token，并暂停运行任务。结束/清空任务或关标签不删除 IDB 笔记。getSiteMemory 仅通过可信侧栏 task:site-memory 入口提供当前站点数据。

## 点击核对未知的有限恢复

动作检查点保存 action、原 URL、documentId、目标 key 和语义描述。点击预期在原 deadline 到达后仍 unknown 时，最多两次返回 observe，交给新快照规划；原结果仍是 unknown/CONDITION_TIMEOUT，recovery=replan，不冒充成功。明确不匹配、wait/完成条件和耗尽恢复次数仍暂停。恢复次数写入 session，核对成功后重置。

未确定点击记录按原文档与节点 key（缺失时语义描述）阻止重发，最多保留两个；新弹窗的独立控件可按原确认策略执行。恢复不重置轮数或等待期限，不取消点击确认，不等于完整自主恢复。

用户补充指令设置 memoryReview 提醒并随每轮上下文传递。成功 memory_write/site_memory_write 后清除；用户手动清空/编辑笔记也消除提醒，避免提示旧请求重新保存。提示模型审查和记录可复用纠正，未新增自动持久化原始指令。

纯延时复用 check，kind 为 delay、expected 为空数组、deadline 为绝对到期时间。每 tick 先检查 origin，再推进计时；不调用网页 verify，到期后清除 check 并进入 observe，下一轮必须重新读取快照。停止、追加指令、结束及记忆修改沿用现有取消机制。延时不额外增加模型轮数，不能绕过后续页面加载、权限、预算或不确定副作用保护。

正文分段 observe 使用可选整数 value；只读结果写入普通 results 并进入下一轮上下文，仍按模型请求累计轮数。读取返回后检查运行代次、URL 与 documentId；停止或替换后的迟到结果不写回。下一 tick 重新观察后才规划动作，不将分段快照 ID 持久化。

控件范围 observe 将受限对象 value 和当前 URL/documentId 写入 nextObservation；只读检查点可跨 worker 唤醒。下一 tick 读取后清空，文档边界变化时默认重读，模型只使用这轮新快照。范围不包含目标 ID，代次改变时清除；不改变累计请求预算或副作用恢复规则。

INPUT_CANCELLED 与 INVALID_FIELD_VALUE 使用稳定 code 进入 reason=input 的暂停状态，不自动重放；前者处理器可能产生副作用，结果保持 unknown，后者在聚焦/事件前拒绝浏览器会清洗的值。worker 重建不会执行暂停任务。

动作核对检查点另保存 dispatch：执行前 unknown，取得回执后更新为原派发状态。后续只读核对及超时沿用此值，旧检查点缺省 unknown，避免把已发出的动作显示为未执行。wheel 沿用执行前检查点、中断后只核对/暂停和停止代次保护，不在运行器增加定时循环。

nextObservation.value 同样接受 regionOffset/regionQuery，沿用控件读取范围的一次性检查点和 URL/documentId/代次边界；区域核对的额外只读捕获由内容脚本负责，不改变轮数或等待 deadline。
