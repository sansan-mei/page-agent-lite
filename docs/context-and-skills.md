# 上下文与记忆

## 每轮模型输入

`prompts.js` 组装稳定系统指令和每轮输入；`backend.js` 以非流式 Chat Completions 发送。每次请求无状态（系统指令 + 含历史的单条用户输入），不回传 tool 结果消息。

- 每轮输入是一个 JSON，字段顺序为：`taskScope`（当前来源与授权集合，只读）、`goal`、`instructions`（按时间排序）、`taskPlan`、`taskSummary`、`historyIndex`、`results`、`siteMemoryIndex`、`globalMemoryIndex`、`memoryReview`、`uncertainClicks`……最后是当前页面快照。稳定内容在前，变化内容在后，便于服务商前缀缓存。
- 较新的用户纠正优先；网页、笔记、摘要都作为不可信资料。不设置服务商专用缓存参数，摘要更新时间不发给模型。
- 仓库 `AGENTS.md` 只约束开发，扩展不读取。
- 导航无需逐站申请任务授权，`taskScope.allowedOrigins` 记录任务来源，不是导航白名单。行动请求须返回实际动作，不能把“准备去做”当作完成；受阻时须说明未完成和具体原因。这是提示约束，不能保证模型始终遵守。

## 模型响应

执行请求有两种协议，由设置 `toolMode`（auto 默认 / native / json）决定；上下文摘要请求始终是纯文本，不带 tools。

| 协议 | 请求 | 回复 |
|---|---|---|
| native | `tools`（`prompts.agentTools()`：注册表每个动作一个 function，参数只描述 plan 字段，`reply` 必填，`additionalProperties:false`）、`tool_choice:"required"`、`parallel_tool_calls:false`；系统指令要求每轮恰好调用一个工具 | 恰好一个 `type:function` 的 tool_call；arguments 解析为对象后以工具名作 `action` 转成同一 JSON plan，交给 `agentPlan` 校验 |
| json | 不带 tools；系统指令要求只返回严格 JSON | `content` 严格 JSON plan |

接口格式 `apiFormat=anthropic` 时请求改走 `/messages`：native 的 tools 转成 `{name,description,input_schema}`，`tool_choice:{type:"auto",disable_parallel_tool_use:true}`（部分 Claude 模型如 claude-opus-5-5 拒绝 any/tool，强制改由系统指令要求恰好一个工具；只回文本按现有规则处理），系统指令作带 `cache_control` 的 system 块，不发送思考参数；`anthropicToChat` 把回复映射成 Chat Completions 形状（`stop_reason` end_turn/tool_use/max_tokens/refusal → stop/tool_calls/length/content_filter，其余为不支持；tool_use 块 → tool_calls；整段 ```json 围栏去掉；usage 含缓存读写 tokens），之后同样交给 `parseChatResponse`。

`parseChatResponse(raw, protocol)` 统一解析并提取 usage。两种协议共用截断、拒绝、空值、超长、非法响应、结束状态的 code；native 另有多个调用 `MODEL_TOOL_CALL_MULTIPLE`（一个都不执行）、参数非对象/非法 JSON/含 `action` 键 `MODEL_TOOL_ARGUMENTS_INVALID`、调用格式或旧式 function_call `MODEL_TOOL_CALL_INVALID`、只有文本 `MODEL_TOOL_CALL_MISSING`；json 协议收到 tool_calls 为 `MODEL_TOOL_CALL_UNSUPPORTED`。都不修补成动作，也不回显响应正文（见 [运行器](agent-runtime.md#错误与恢复)）。

auto 回退：回复只有文本但文本本身是严格 JSON 动作时，本轮直接按 json 解析使用，不记录；native 请求遇到 HTTP 400/422 且正文提到 tools/tool_choice/function，或回复是非 JSON 文本时，把当前 modelIdentity 记入 `nativeToolsUnsupported`，本轮报 `MODEL_PROTOCOL_FALLBACK`，之后该模型走 json。重新保存 API 设置会清空记录、重新尝试 native。native 模式下同样情况报 `MODEL_TOOLS_UNSUPPORTED` / `MODEL_TOOL_CALL_MISSING`，不记录。上下文估算在 native 下计入 tools schema。

## 记忆

两层长期记忆和网站技能都只在每轮提供目录，正文由模型用工具按需读取；工具由后台执行，不经网页，但每次请求仍计一轮。已确定需要的 2–8 条独立读取可用 `read_references` 合为一次模型请求；逐条结果、错误与失效规则不变，不合并依赖前项结果才能选择的读取，也不额外读取无关笔记。

| 层 | 工具 | 目录 | 存储与范围 | 容量 |
|---|---|---|---|---|
| 网站 | `site_memory_read/write/delete/clear` | `siteMemoryIndex`（id、updatedAt、source） | IndexedDB，按完整 origin，跨任务/标签/重启 | 32 条/64000 字符，单条 2000 |
| 全局 | `global_memory_read/write/delete/clear` | `globalMemoryIndex` | IndexedDB 单一 global 记录 | 同网站 |
| 网站技能 | 只有 `site_skill_read` | `siteSkillIndex`（id、description） | IndexedDB `skills`，按完整 origin | 16 个/48000 字符，说明 200、步骤 4000 |

- 容量满时返回工具错误，由模型删除或压缩，不静默丢弃。
- 提示词要求：网站笔记记本站稳定经验；全局只记用户明确的跨站偏好或适用范围清楚的通用经验，范围不清时留在本站或询问；不记凭据、验证码、临时 DOM ID 或整段网页。单站经验不会自动提升为全局。这些是提示约束，模型不一定遵守。
- 写入携带本轮读取的版本（CAS）；模型写全局笔记会使其他在途请求失效。
- 任务复盘：任务完成后再发一次 JSON 文本请求（`P.reviewSystem` / `reviewInput` / `parseReview`，不带工具 schema），输入为目标、补充指令、摘要、近期结果（≤ 24000 字符，不含 observe 正文和填写值）、两层笔记正文（各 ≤ 16000 字符，超出只给 id）与本站技能全文，输出最多 4 条网站/全局笔记和 2 条技能的写入或删除。
- 技能 = 本站可复用流程：description 说明适用的目标，正文是用可见标签/菜单路径/URL 写的编号步骤、每步的核对方式和踩过的坑。只由复盘写入（多步流程成功完成时新建；读过的技能被证明错误或被用户纠正时同 id 重写），执行模型只能读；用户可在设置页删除或清空，不暂停任务、不使在途请求失效。技能是不可信的历史参考，执行时仍以当前页面为准。触发与取消见 [运行器](agent-runtime.md#任务复盘)。

### 记忆变更的失效规则

| 变更 | 影响范围 | 处理 |
|---|---|---|
| 用户修改网站笔记 | 同 origin 任务 | 取消同站请求、暂停；清理摘要、site_memory_* 与 history_read 结果 |
| 用户修改全局笔记 | 所有任务 | 取消各站请求、暂停；清理全局读取结果、history_read 与摘要 |
| 任意记忆变更 | 同上 | 清空 `taskPlan` 及请求中的 subgoals 元数据 |

都保留等待期限和 executing 检查点，继续时先只读核对。清空笔记不删除用户补充指令，旧摘要和归档也不能恢复已删内容。

## 上下文压缩

- 触发：估算上下文 ≥ `(contextTokens − 2000) × compressionThreshold / 100`。默认 100000 / 80%，窗口 8192–262144，阈值 50–95%。不按条数触发。
- 估算：以上次接口 `usage.prompt_tokens` 为锚点加本次变化量；无 usage 时全量估算（ASCII 约 4 字符/token，非 ASCII 约 1 字符/token）。锚点绑定 endpoint/model/language/key 的 SHA-256，配置变化、压缩、记忆清理后失效。缓存 token 只展示，不从容量扣除。
- 保留：至少最近 6 条完整结果，向前扩展到输入预算的 20%。其余旧结果和上次摘要交给独立摘要请求；单条超 4000 字符的结果只取前 2000 + 后 1000 字符并标注可用 history_read 恢复。摘要输入估算超过输入预算 90% 时暂停。
- 摘要：五个字段（已完成及证据、待完成、关键事实与纠正、失败方法、未确定操作），每字段 ≤ 5 条、每条 ≤ 240 字符，总计 ≤ 4000 字符。
- 写入：`contextSummary {content, through, updatedAt}`、`contextArchive`（id/from/to/原始 results，总 ≤ 100 万字符，满则暂停）与裁剪后的 results 在同一次任务更新中保存；失败则不裁剪。
- 读取：`history_read(id, value=offset)` 每次 4000 字符，返回 nextOffset，只能读当前来源的归档；旧 ID 不能作为操作目标。
- 摘要请求计轮数、可取消，停止/补充后的迟到摘要丢弃。压缩后设 `compactionGuard`，若仍超阈值则暂停，成功执行一次模型请求后解除。

## 跨来源

切换来源后，模型只收到用户原目标、补充指令、累计预算和授权目录；旧站点的结果、摘要、计划、完成条件、笔记正文都不带入，网站目录按新 origin 重新装配，全局目录照常按需读取。例外是多标签切换留下的 `tabTrail` 与 `handoffs`（模型在 `tab_switch`/`tab_open` 写的交接笔记），以及模型的进度笔记 `progress`（见 [运行器](agent-runtime.md#进度笔记)），见 [多标签执行](agent-runtime.md#多标签执行)。详见 [运行器](agent-runtime.md#跨来源切换)。

## 未实现

全局技能（跨网站流程）、技能导入导出、跨会话检索与恢复、精确 tokenizer、整段聊天持久化。方向见 [Roadmap](../ROADMAP.md)。
