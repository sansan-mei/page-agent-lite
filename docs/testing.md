# 测试

本文只写怎么测、覆盖什么、还没验证什么。每次实际执行的命令和数字写在提交信息或 PR 描述里。

## 三个层级

| 层级 | 工具 | 能证明 | 不能证明 |
|---|---|---|---|
| Node 模拟 | `npm test`：Node VM + linkedom + Chrome API 替身 | 运行器、存储、协议、条件、侧栏逻辑 | 真实浏览器事件、扩展生命周期 |
| 浏览器 + stub 模型 | Playwright 加载真实 MV3 扩展或真实 DOM，模型用本机确定性 stub | 注入、isolated world 消息、真实 DOM 事件、worker 终止、session/IndexedDB | 线上模型的决策质量 |
| 真实模型 | 人工在真实网站执行 | 端到端效果 | — |

三层结果分开报告，下层通过不能替代上层。

## 命令

```sh
npm ci --ignore-scripts --no-audit --no-fund
for f in extension/*.js scripts/*.cjs; do node --check "$f"; done
npm test
git diff --check
```

浏览器脚本需要 Playwright 和 Chromium/Edge，只访问 Playwright 路由的合成页面：

| 脚本 | 覆盖 |
|---|---|
| `scripts/browser-smoke.cjs` | 完整扩展链路：内部页对话与目标授权、任务、填写/点击、翻页、导航与跨来源、等待阶段 worker 终止、丢回执不重发、记忆与浏览器重启、历史、范围、成员关闭、诊断 |
| `scripts/page-read-smoke.cjs` | 分页/查找、区域读取与核对、敏感字段排除、离屏点击 |
| `scripts/form-input-smoke.cjs` | 原生 setter、beforeinput 取消、回滚、节点替换、值清洗、敏感字段授权与旧快照拒绝 |
| `scripts/aria-select-smoke.cjs` | listbox 分组、同名选项、ARIA 状态核对 |
| `scripts/editable-smoke.cjs` | 纯文本 contenteditable |
| `scripts/hover-controls-smoke.cjs` | 可点击行内的悬浮操作（a、aria-haspopup）、visibility 覆盖与继承隐藏、真实点击 |
| `scripts/overlay-smoke.cjs` | 部分遮挡改点可见点、完全遮挡回报遮挡层控件 key 且不派发、按 key 关闭浮层后重试、固定底栏居中后点击 |
| `scripts/cross-origin-extension-smoke.cjs` | 加载真实 MV3 扩展，真实框架发现、权限范围、isolated world 注入、敏感授权、填写、核对、旧快照拒绝、真实运行器权限暂停不重试及加入范围后继续、重复/失败核对不移动指针、记住授权跨浏览器重启、其他顶层来源隔离与忘记授权；不点付款，模型决策为本机函数 stub |
| `scripts/cross-origin-frame-smoke.cjs` | 真实跨源 DOM + Chrome API 替身：任务范围、敏感字段授权、填写与核对、过期快照、取消、遮挡、权限撤销与框架导航；不点付款 |
| `scripts/iframe-smoke.cjs` | 同源 iframe 读取与 frame 标注、跨源/嵌套标注未读、框架内敏感字段排除、填写/勾选/选择/按键/点击、区域核对、框架内滚入视野、顶层遮挡、移除框架后过期 |
| `scripts/input-smoke.cjs`、`wheel-smoke.cjs`、`svg-click-smoke.cjs`、`page-pointer-smoke.cjs` | 按键/双击/右键、滚轮、SVG 命中点击、虚拟指针常驻、移动途中换目标/重复定位、到达后点击反馈、滚动/缩放/清理与减少动态效果 |
| `scripts/ui-preview.cjs` | 用合成数据生成 README 预览图，检查 320/390/480px 侧栏无横向溢出；`PAGE_AGENT_LOCALE=en` 渲染英文界面到 `tests/browser-output/en/`，不覆盖 `docs/assets` |

- 除 `browser-smoke.cjs` 和 `cross-origin-extension-smoke.cjs` 外，组件脚本用真实 DOM + Chrome 消息 stub，不是完整扩展。
- `browser-smoke.cjs`：CI 中用 xvfb 运行；本机加 `--local` 无窗口运行并允许未提交源码。只在临时复制的 manifest 里注入 loopback 权限，fixture 预置主机权限。
- 环境变量：`PAGE_AGENT_CHROMIUM` 指定浏览器；`PAGE_AGENT_SMOKE_OUTPUT` 指定输出目录（默认 `tests/browser-output/`，不提交）。使用临时 profile，不碰用户配置。
- 侧栏文档在测试标签页打开，不是原生侧栏。
- 界面翻译：`tests/i18n.test.js` 校验两份 `messages.json` 键与占位符一致、页面与脚本引用的键都存在、英文界面下侧栏/设置页无中文静态文案、默认回复语言跟随界面语言且不覆盖已保存值；其余 UI 测试用 `tests/i18n-helper.js` 以 zh_CN 文案运行。

## CI

`.github/workflows/ci.yml`：`test` job 跑 `node --check extension/*.js` 和 `npm test`；`smoke` job 安装 Playwright Chromium 跑 `browser-smoke.cjs`，上传 `tests/browser-output/`。`.github/workflows/pages.yml` 只部署 `site/` 宣传页，不跑测试。`.github/workflows/release.yml` 在推送 `v*` tag 时用 `scripts/release-check.cjs` 核对版本与 CHANGELOG，再跑 `npm test` 后打包发布。

## 尚未验证

- 跨源 iframe：原生权限弹窗、线上支付组件、重定向/嵌套框架与真实模型端到端；合成站点 smoke 不替代真实支付页验收。

- 线上真实模型：规划、记忆选择、摘要质量、子目标质量、缓存命中与费用。
- 原生工具调用：请求体、tool_call 转换、多调用/坏参数拒绝、auto 回退与记忆只有 Node 假 fetch，浏览器 smoke 的假接口按 tool_calls 应答；真实服务商（OpenAI、DeepSeek、通义、Ollama 等）对 `tools`、`tool_choice:"required"`、`parallel_tool_calls` 的接受情况及 400 正文措辞未验证。
- Claude 格式：请求头与请求体、回复映射、围栏去除、auto 回退由 Node 假 fetch 覆盖，浏览器 smoke 不覆盖。2026-11-27 在 Anthropic 兼容中转（claude-opus-5-5）上实测：`tool_choice` any/tool 返回 400，auto + `disable_parallel_tool_use` 正常返回单个 tool_use，并用 backend.js 真实请求完成一轮；官方 Anthropic API（OAuth 通道）同样拒绝 any/tool、接受 auto；API key 通道与提示缓存命中未验证。
- 原生侧栏位置与工具栏手势、原生主机权限弹窗（授权/拒绝/重试）、权限升级后重新启用。
- 动作派发瞬间强杀 worker/浏览器进程（目前只验证了等待阶段的真实 worker 终止；派发中与跨来源恢复仅模拟）。
- 真实 React/Vue 等框架、组件库、视频站点、慢加载页面与多种动态网站。
- IndexedDB 配额耗尽、升级阻塞、隐私模式；扩展卸载/升级后的数据丢失。
- 原生下载对话框；真实用户数据下诊断导出的脱敏效果。
- `run_script`：注册与按可用性暴露、参数校验、结果截断/异常/超时、批准/拒绝/过期/作废、本任务内允许（同来源免暂停、跨来源/撤销/结束/权限移除后恢复暂停）、仅可信侧栏可批准、设置页权限申请与状态只有 Node 模拟（真实 runtime + browser-tools，`userScripts`、`permissions` 为替身）。真实 Chrome 中的 `userScripts.execute`、可选权限弹窗、「允许用户脚本」开关（无头 Chromium 无法打开）、MAIN/USER_SCRIPT 差异、侧栏批准卡片的真实布局，以及真实模型是否在合适场景选用并写出可读脚本均未验证。
- 英文界面只有 Node + linkedom 检查与一次英文侧栏截图；真实 Chrome 中 `__MSG_*__` 名称、`chrome.i18n` 语言切换与设置页英文布局未在浏览器验证。`ui-preview.cjs` 的长对话步骤仍用旧 `task:1` 存储键推送更新，当前会在该步失败。
- 目标模式与核对后重新规划：次数上限、未确定点击放行、完成条件重规划、侧栏开关与后台命令校验只有 Node 模拟；真实模型在目标模式下是否会重复副作用、真实富文本编辑器的空白改写是否都被宽松比较覆盖均未验证。
- `debugger` 真实输入：会话按需 attach/复用/释放、提示条取消、占用、中途断开、代次变化不发送只有 Node 替身（假 `chrome.debugger`）；真实 Chrome 的提示条、取消行为、DevTools 同时打开、worker 终止后会话是否保留、坐标在缩放/高 DPI 下的准确性均未验证。
- 多成员任务：成员加入/移出/关闭、otherTabs 列表与读取授权、tab_switch、tab_open/tab_close、执行标签关闭改绑、切换中断对账只有 Node 模拟（真实 store + 假浏览器）与侧栏 stub 测试；真实浏览器中的 `tabs.create`/`tabs.remove`、后台标签加载与注入、原生侧栏在成员标签上的表现、侧栏读取授权卡片的真实渲染、真实模型是否合理选用标签工具均未验证。
