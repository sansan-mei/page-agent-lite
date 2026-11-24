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
| `scripts/trusted-hover-smoke.cjs` | 加载真实扩展：纯 CSS `:hover` 按钮在真实悬浮前不可见、之后可点击，断开调试后悬浮保持，已取消的运行不移动鼠标；需 Playwright 自带 Chromium（品牌版 Chrome 不加载 `--load-extension`） |
| `scripts/hover-controls-smoke.cjs` | 可点击行内的悬浮操作（a、aria-haspopup）、visibility 覆盖与继承隐藏、真实点击 |
| `scripts/input-smoke.cjs`、`wheel-smoke.cjs`、`svg-click-smoke.cjs`、`page-pointer-smoke.cjs` | 按键/双击/右键、滚轮、SVG 命中点击、虚拟指针 |
| `scripts/ui-preview.cjs` | 用合成数据生成 README 预览图，检查 320/390/480px 侧栏无横向溢出 |

- 除 `browser-smoke.cjs` 外，组件脚本用真实 DOM + Chrome 消息 stub，不是完整扩展。
- `browser-smoke.cjs`：CI 中用 xvfb 运行；本机加 `--local` 无窗口运行并允许未提交源码。只在临时复制的 manifest 里注入 loopback 权限，fixture 预置主机权限。
- 环境变量：`PAGE_AGENT_CHROMIUM` 指定浏览器；`PAGE_AGENT_SMOKE_OUTPUT` 指定输出目录（默认 `tests/browser-output/`，不提交）。使用临时 profile，不碰用户配置。
- 侧栏文档在测试标签页打开，不是原生侧栏。

## CI

`.github/workflows/ci.yml`：`test` job 跑 `node --check extension/*.js` 和 `npm test`；`smoke` job 安装 Playwright Chromium 跑 `browser-smoke.cjs`，上传 `tests/browser-output/`。`.github/workflows/pages.yml` 只部署 `site/` 宣传页，不跑测试。

## 尚未验证

- 线上真实模型：规划、记忆选择、摘要质量、子目标质量、缓存命中与费用。
- 原生侧栏位置与工具栏手势、原生主机权限弹窗（授权/拒绝/重试）、权限升级后重新启用。
- 动作派发瞬间强杀 worker/浏览器进程（目前只验证了等待阶段的真实 worker 终止；派发中与跨来源恢复仅模拟）。
- 真实 React/Vue 等框架、组件库、视频站点、慢加载页面与多种动态网站。
- IndexedDB 配额耗尽、升级阻塞、隐私模式；扩展卸载/升级后的数据丢失。
- 原生下载对话框；真实用户数据下诊断导出的脱敏效果。
- 多成员任务：成员加入/移出/关闭只有 Node 模拟与侧栏 stub 测试，未在真实浏览器验证；tab_switch、tab_open/tab_close 尚未实现。
