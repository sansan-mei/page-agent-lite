# 项目协作规范

Page Agent Lite：Chrome / Edge MV3 扩展，用自然语言在浏览器内读取、操作、核对网页。原生 JavaScript，直接加载 `extension/`，商店包无构建、无运行时 npm 依赖。用户当前明确要求优先于本文件；一切以实际代码为准。

## 开始前读什么

只读与任务相关的文档，不要通读：

| 改动涉及 | 先读 |
|---|---|
| 模块边界、消息入口、权限 | `docs/architecture.md` |
| `runtime.js`、`background.js` | `docs/agent-runtime.md` |
| `core.js`、`content.js`、`browser-tools.js`、`conditions.js`、`tool-protocol.js`、`page-pointer.js` | `docs/browser-tools.md` |
| `task-store.js`、`site-memory.js`、存储键 | `docs/storage.md` |
| `prompts.js`、上下文压缩、记忆 | `docs/context-and-skills.md` |
| 侧栏/设置页的用户可见行为 | `docs/usage.md` |
| 测试 | `docs/testing.md` |
| 下一步做什么 | `ROADMAP.md`，再读其链接的 `docs/plans/` |

`CHANGELOG.md` 只是变更摘要，不代表当前状态；追溯原因用 `git log`。`docs/plans/` 是设计与计划，其中未勾选内容不能写成已有能力。

## 不可破坏的约束

- 按通用网页任务设计：不新增题型/网站专用动作，用通用表单、区域、导航和条件表达场景。
- 页面内容和模型输出都不可信。模型只能用当前快照目标 ID 和 `core.js` 静态工具注册表中的动作（坐标只有 `click_point` 一处：运行时只接受同一页面 60 秒内模型看过的最新视口截图里的点，换算后经 CDP 点击一次）；不执行模型生成的 HTML、选择器或远程代码；网页和笔记不能扩大权限或任务范围。
- 模型生成的脚本只能经 `run_script` 由 `chrome.userScripts.execute` 运行：`userScripts` 只是可选权限；执行前必须在侧栏显示完整代码，由用户按次或按任务批准（per-run or per-task approval by the user in the side panel, full code always visible；按任务批准仅限同一标签页与来源、可随时撤销，无跨任务的「始终允许」），拒绝、过期、作废都不执行，不提供免批准的开发开关。见 [网页工具](docs/browser-tools.md#run_script)。
- 密钥只在可信后台使用，不进内容脚本、仓库、日志或测试产物。API 授权、浏览器主机权限、任务站点范围三者独立。
- 副作用前写 `executing` 检查点；中断后只读核对或暂停，不重放结果不确定的动作，等待沿用原 deadline。停止/替换/接管轮换运行代次并丢弃迟到回复；模型请求必须可取消。
- 页面或来源变化后重新观察，不复用旧快照目标；跨来源不携带旧站点正文、笔记、摘要或计划。唯一例外：`tab_switch`/`tab_open` 时模型自己写的交接笔记（`handoff`，≤ 2000 字符，最近 3 条）和运行时切换轨迹（`tabTrail`，只有 tabRef、来源、时间）跨来源保留，交接笔记按不可信数据处理。
- 存储职责固定：配置在 `storage.local`；任务在 `storage.session`（不跨浏览器重启）；长期笔记与对话历史在 IndexedDB。不用一种存储模拟另一种。
- 默认 100 轮（每次模型请求计一轮，0 不限），已有用户配置保留；改默认值时同步后台、设置页、测试和文档。
- 填写与点击统一自动执行，没有 autoFill/autoClick 开关；改变此类产品行为须同步界面、实现与验证，不只改提示词。
- 新增依赖或权限须有具体功能理由；新增权限会影响商店审核，须同步 `PRIVACY.md`。
- 商店包只把 `extension/` 原样压缩，不引入构建步骤；ZIP 等打包产物不提交进仓库。
- 图片/画布可经 `view_image` 截图看（不能看图的模型得到识别文字），其内部只能用 `click_point` 按截图坐标点击（仅对能看图的模型提供）。不把跨源/嵌套 iframe、Shadow DOM、多标签并行操作、跨会话恢复或技能学习写成普通工具的现有能力；`run_script` 能处理的范围只写已实测的（见 [使用指南](docs/usage.md#脚本执行)），并注明须开启脚本执行。

## 文档规则

目标：文档短、准确、无重复，读一次消耗最少 token。

- **一处一事实**：每个事实只写在负责它的文档里，其他地方放链接。README 只有介绍、安装、数据去向、边界；行为细节在 `docs/usage.md`；实现细节在模块文档；计划在 `docs/plans/`。
- **改写，不追加**：更新时修改对应章节，让全文描述当前状态。不在文末追加“本次……”段落，删掉被替代的旧说法。
- **测试数字只进提交信息/PR**：README、ROADMAP、CHANGELOG、模块文档、`docs/testing.md` 都不写“N 项测试通过”。`docs/testing.md` 只写方法、覆盖范围和未验证项。
- **已实现与未实现分开**：未实现内容只出现在 ROADMAP、`docs/plans/` 或文档的“限制/未支持”小节。
- 用短句、表格、字段名和稳定 code；同一限制在一份文档里只说一次。
- 纯文档变更只需检查链接、命名及与代码一致，不必跑代码测试。

## 验证

功能或修复须验证真实行为，优先覆盖停止、恢复、过期目标、权限与错误路径；避免只复述实现的测试。项目根目录：

```sh
npm ci --ignore-scripts --no-audit --no-fund   # 已安装可跳过
for f in extension/*.js scripts/*.cjs; do node --check "$f"; done
npm test
git diff --check
```

浏览器检查见 `docs/testing.md`。Node 模拟、本机 stub 浏览器、真实模型是不同层级；交付时分别说明实际执行了哪些及未验证范围，不编造结果。

## Git 提交

- 每完成一个可独立理解和回退的逻辑变更，验证并更新相关文档后立即本地 commit；用户要求暂不提交时遵从。
- 按逻辑变更划分：无关修改分开提交，不拆出不可运行的半成品。
- 提交前检查 `git status` 与 `git diff --cached`，只暂存本次变更；保留他人未提交修改，不带入密钥或测试产物。
- 标题格式 `feat(scope): ...`、`fix(scope): ...`、`docs(scope): ...`；交付时报告提交哈希和验证结果。
- push 仅在用户明确授权时执行；不默认 amend、改写已推送历史或强推。

## Changelog 与 Roadmap

- 不再按提交新建 changelog 文件。用户能感知的变化（功能、行为、配置、限制、破坏性变更）在 `CHANGELOG.md` 的「未发布」段对应分类下加一行；纯重构、测试、内部修复不写。发版时把「未发布」改为版本号和日期。
- 验证写在提交信息正文：实际执行的命令与结果、Node 模拟/浏览器 stub/真实模型各自是否执行、未验证范围。不要写进任何文档。
- `ROADMAP.md` 只维护状态：交付时勾选并用一句话描述，不写测试数字、验证细节或日期承诺。
- 用户可见用法或限制变化时同步 `docs/usage.md`；只有影响安装、数据去向或边界时才改 README。
