# Page Agent 能力吸收计划

核对日期：2026-11-23（Asia/Singapore）。状态：后续实施计划，规划本身不代表实现；PA1 正文分段首个增量已落地，控件偏移分页与标签/名称片段查找已实现；PA2 原生字段事件兼容增量已实现；语义层级增强、区域分页及 PA2 ARIA 选择器归属/状态核对增量已实现；组合输入与真实框架兼容仍待推进。目标是将阿里 Page Agent 中适合浏览器任务的机制融入当前原生 MV3 扩展，并与已有的任务检查点、结果核对、上下文压缩及双层长期记忆协同。

上游核对版本：`d8dd334487cb2de14206aa8ca939a1613cd612dc`。依据公开 README 与源码静态检查，未安装对方产品进行同任务对测；有源码入口不表示已验证其所有网站兼容性。标为“本项目增强”的条目是本项目需求推导，不宣称上游已具备完全相同能力。

## 已有基础与吸收边界

本项目已有文本 DOM 操作、视口/弹窗优先抽取、容器四向滚动、合成 hover、目标高亮、暂停问答、停止取消、同源翻页恢复、结果卡片和 OpenAI 兼容请求；这些作为增强基础，不重复列为待新增。网站/全局长期记忆已实现，但不等于技能学习。

吸收以机制适配和有来源的局部移植为主，逐项核对上游提交、许可证和行为；不直接替换现有运行器，不要求打包整个 TypeScript monorepo。直接复制或改编代码时保留对应 MIT 版权及来源声明，另核对其 browser-use 衍生部分的归属。每个阶段提供可单独验证和回退的变更。

## 阶段一：网页读取与控件执行（优先）

| 编号 | 上游参考与本项目现状 | 待吸收/增强内容 | 验收重点 |
|---|---|---|---|
| PA1 | DOM 树简化、语义标签/属性和视口范围；本项目抽取有容量截断 | 增强角色、名称、分组、层级和相邻上下文，减少重复文字；本项目增加长页面分区/局部读取与按需定位 | 目标在原截断范围外可发现；保留范围与截断信息，不能把未读当不存在 |
| PA2 | React patch、原生 setter 和输入事件；本项目已有基本事件与自定义控件识别 | 完善受控 input/textarea、自定义选择器、日期/组合输入和弹层状态的通用兼容 | 输入后模型值被框架接受；重渲染/回滚可被识别，不把派发事件当保存成功 |
| PA3 | actions 中已有 contenteditable 输入路径；本项目未支持富文本 | 先支持简单 contenteditable 的纯文本读写，再评估常见编辑器适配，统一核对实际内容 | 取消的 beforeinput 不继续写入；不破坏无关节点，不执行模型 HTML；不支持的编辑器明确返回 unsupported |
| PA4 | 独立 PageController、前后更新事件和交互反馈；本项目已有工具分层和虚拟指针 | 明确观察/定位/执行适配边界，集中可测试的控件兼容与快照更新钩子；提供用户接管后重新观察的入口 | 用户修改页面后旧目标和旧计划失效，接管不导致旧提交重放；无需求时不做大规模重构 |
| PA5 | viewport、属性白名单、文本简化；本项目 M4 未实现 | 在局部读取基础上评估快照差异和低影响动作批量执行（本项目增强） | 比较请求 token 与完成步数；批次遇页面变化立即中断，提交/导航独立核对 |

兼容按通用控件模式和框架行为实现，不新增网站/题型专用运行器动作。不为兼容而无条件向主世界注入框架补丁；如隔离世界无法完成，先明确可信桥接的数据与权限边界。

## 阶段二：任务组织、页面导航与标签页

| 编号 | 上游参考与本项目现状 | 待吸收/增强内容 | 验收重点 |
|---|---|---|---|
| PA6 | reflection 中的上步评价/下一目标；本项目已有有限重规划 | 形成简洁的结构化子目标、进度和证据，按实际反馈修订下一步；与 Hermes 侧计划/技能方向衔接 | 页面无进展、条件不满足、用户更正能改变计划；不保存或展示模型私有思维链，不额外强制一轮规划请求 |
| PA7 | 扩展 MultiPageAgent、TabsController 与打开/切换/关闭工具；本项目只支持单标签同源恢复 | 增加可信导航工具、受限 URL 校验和任务内授权站点集合；随后支持列举允许的标签页、打开/切换/关闭 | 未授权 origin 不读取不执行；拒绝内部协议；跨页重新观察，任务预算不重置；初始/用户标签页的关闭策略明确 |
| PA8 | 多页控制器同步标签与等待加载；本项目任务按 tabId 隔离 | 建立单任务拥有的标签页集合及当前执行标签，保留其他独立任务；站点笔记随 origin 切换，全局笔记沿用 | 标签关闭、跳转、权限撤销和停止不串任务；停止后所有所属标签页均无迟到动作 |

PA7/PA8 会改变当前任务与权限模型，须先更新存储/恢复设计，再开放工具。全站授权不等于将所有已打开标签页无差别交给模型；外部 API 依赖此任务范围稳定后再接入。

## 阶段三：工具接口、上下文与模型兼容

| 编号 | 上游参考与本项目现状 | 待吸收/增强内容 | 验收重点 |
|---|---|---|---|
| PA9 | customTools、schema、AbortSignal 和任务/步骤 hooks；当前白名单分布在多个模块 | 建立可信工具注册表与统一参数/结果定义，提供内部生命周期钩子；允许扩展包内静态工具扩展 | 保持 V2 稳定 code/status、副作用分类、取消和预算；模型/网页不能注册任意工具或代码 |
| PA10 | instructions.getPageInstructions、可选 llms.txt；本项目已有网站/全局笔记 | 整理系统规则、当前用户指令、站点知识与技能的上下文层级；llms.txt 仅作可选不可信站点资料评估 | 网站文本/笔记不能覆盖用户指令或工具权限；不默认抓取全站资料，不将站点资料自动保存为全局记忆 |
| PA11 | transformPageContent 的脱敏/整理接口；本项目排除密码等字段 | 增加受信任的内容过滤与预览、敏感字段排除和数据最小化配置（本项目增强），不开放用户任意 JS 回调 | 敏感内容不进入请求、摘要、工具结果和导出；过滤后不错误匹配目标，仍说明无法识别所有隐私 |
| PA12 | llms 层原生工具调用、结果规范化和模型测试；本项目为严格 JSON、非流式兼容接口 | 分离模型适配，评估原生 function calling 与现有严格 JSON 双路径、窄范围格式容错和模型配置诊断 | 两条路径执行相同白名单和结果核对；不“修复”出新动作，不因格式重试重复副作用；错误与日志不泄露密钥 |
| PA13 | status/activity/history 与会话 JSON 导出；本项目有会话内只读历史和工具卡片 | 统一执行事件，增加耗时/用量/错误诊断及脱敏轨迹导出，再衔接历史检索和跨重启上下文续接 | 导出范围明确，排除凭据、执行 token 和无关网站；查看/导出不执行动作，重启恢复先观察不重放 |

工具注册与模型适配按新增能力需要逐步实施，不为接口形式增加依赖或构建。低影响批量执行仍需各动作结果，不能借注册表开放任意脚本。历史持久化是本项目独立增强，不能由“上游有历史导出”推定其支持完整任务恢复。

## 阶段四：可选开发者集成（后期评估）

| 编号 | 上游参考 | 本项目计划与采用条件 | 验收重点 |
|---|---|---|---|
| PA14 | 网页 JS SDK、execute API、自定义工具/hooks | 稳定内部工具接口后，再评估可复用 PageController/API 或嵌入式 SDK；原生扩展保持直接加载 | 不把后台密钥传到网页；不因 SDK 引入必需构建或第二套执行循环 |
| PA15 | window.PAGE_AGENT_EXT 扩展 API 和授权 token | 有明确外部调用需求时，设计用户授权的任务启动/状态/停止桥接，限定调用源、任务与能力 | 默认关闭；校验 origin、消息来源、重放与撤销；网页不能直接读取配置、记忆或检查点，不照搬网页 localStorage 存长期授权凭据 |
| PA16 | MCP execute_task/get_status/stop_task，依赖本机 Node 桥接 | 保留可选 MCP 适配评估，用于外部 Hermes/Codex 等调用；与“在扩展内借鉴 Hermes 机制”分开 | 独立可选组件；基础使用不依赖 Node/守护进程，认证和断连停止明确，不暴露任意远程脚本执行 |

MCP 与外部桥接目前未实现，是否开发取决于实际需求；不改变当前无需独立服务的默认架构。SDK、扩展 API 与 MCP 不是近期网页执行改进的前置条件。

## 不直接吸收与独立方向

- 不开放上游实验性的模型 JavaScript 执行工具；继续使用当前快照目标与白名单动作。
- 不把可覆盖系统提示词或任意内容回调原样暴露给网页；只吸收可信扩展代码内部的分层与钩子机制。
- 不复制其整套依赖、构建和运行器，不将点击/输入重新改成逐次审批；保留明确用户暂停指令、停止和结果未知保护。
- Shadow DOM、iframe、截图/视觉、文件上传、键盘快捷键和复杂编辑器继续保留独立评估；本次未充分确认上游支持范围，不以“吸收”名义宣称已具备。需要时先核对源码，再设计授权、快照与核对边界。
- 双层记忆、技能学习和跨会话恢复继续按本项目/Hermes 方向设计，不据上游 memory/reflection 字段推断已有持久技能。

## 交付与推进

紧接着先做 PA1 长页面分区/局部读取与 PA2 常见控件兼容，再推进 PA3/PA5、PA6，以及 PA7/PA8。PA9–PA13 按相关功能需要穿插实施，PA14–PA16 保留后期可选评估。实际顺序可根据使用反馈调整，不承诺日期。

每项交付包含实现、必要的通用场景回归、验证范围、README/模块文档、Roadmap 勾选与独立 changelog。持续补充 V1 异常路径，不把完整验收当新功能的硬门槛。浏览器 stub 验证工具链，真实模型另报；比较成功率、重复副作用、请求数/token 和人工介入，不能只凭工具数量声称效果提升。

## 上游依据

以下链接固定本次核对版本，后续移植前再核对差异与许可证。

- [README 与许可](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/README.md)、[MIT License](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/LICENSE)。
- [DOM 简化与属性](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/page-controller/src/dom/index.ts)、[PageController](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/page-controller/src/PageController.ts)。
- [通用输入与滚动](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/page-controller/src/actions.ts)、[React 兼容](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/page-controller/src/patches/react.ts)、[Ant Design 参考](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/page-controller/src/patches/antd.ts)。
- [配置、hooks、内容变换与 reflection](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/core/src/types.ts)、[工具与脚本实验项](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/core/src/tools/index.ts)。
- [多页 Agent](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/extension/src/agent/MultiPageAgent.ts)、[标签页工具](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/extension/src/agent/tabTools.ts)。
- [模型协议](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/llms/src/types.ts)、[会话导出](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/extension/src/lib/history-export.ts)。
- [扩展 API](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/extension/docs/extension_api.md)、[MCP](https://github.com/alibaba/page-agent/blob/d8dd334487cb2de14206aa8ca939a1613cd612dc/packages/mcp/README.md)。
