# 参与贡献

欢迎提交可复现的问题、改进建议和 Pull Request。开始前请阅读 [AGENTS.md](AGENTS.md) 与 [架构](docs/architecture.md)，保持原生 JavaScript、MV3 与无运行时依赖的结构。

## 本地开发

1. 安装 Node.js 22+，执行 `npm ci --ignore-scripts --no-audit --no-fund`。
2. 在 Chrome / Edge 开发者模式加载 `extension/`。
3. 修改后重新加载扩展并刷新测试页。不要使用真实账号提交不可撤销的测试数据。
4. 执行 `npm test`、扩展脚本 `node --check` 和 `git diff --check`。浏览器检查见 [测试文档](docs/testing.md)。

## 宣传页

`site/` 是 GitHub Pages 宣传页：纯 HTML/CSS/JS，GSAP 从 jsDelivr 加载，不属于扩展包。图片不在 `site/` 里重复保存，部署时（`.github/workflows/pages.yml`）从 `extension/icons/` 与 `docs/assets/` 复制到 `site/assets/`。

- 本地预览：先运行一次 `scripts/store-shots.cjs`（会复制图片），再直接打开 `site/index.html`；`?lang=en` 切英文，`?static` 关闭动画。
- 商店截图：`PAGE_AGENT_CHROMIUM=<chrome 路径> node scripts/store-shots.cjs`，输出中英文 1280×800 截图和 440×280、1400×560 宣传图到 `dist/store/`；`?shot=<区块 class>` 单独渲染某个区块。
- 上架后把 `site/main.js` 的 `STORE_URL` 改成商店地址，按钮会变成「免费添加到 Chrome」。

## 发版

1. 把 `extension/manifest.json`、`package.json`、`package-lock.json` 的版本改成同一个新版本；把 `CHANGELOG.md` 的「未发布」内容移到 `## <版本>（日期）` 下。
2. 合入 `main` 后打 tag 并推送：`git tag -a v1.0.1 -m "v1.0.1" && git push origin v1.0.1`。
3. `.github/workflows/release.yml` 自动核对版本与 CHANGELOG、跑测试，把 `extension/` 原样打成 zip、生成商店截图，并发布到 GitHub Release；版本对不上会直接失败，不会发布。旧 tag 可在 Actions 页手动运行该 workflow 补发。
4. 从 Release 下载 zip 上传到 Chrome 应用商店（暂未自动上传）。

## 提交问题

请提供浏览器版本、扩展版本、重现步骤、预期与实际结果。截图与日志先移除 API 密钥、Cookie、个人信息及站点敏感内容。安全漏洞不要公开提交，见 [SECURITY.md](SECURITY.md)。

## 提交修改

一次 PR 解决一个清楚的问题，说明行为变化、验证结果和未覆盖范围。用户能感知的变化在 [CHANGELOG.md](CHANGELOG.md) 的「未发布」段加一行；按 [AGENTS.md](AGENTS.md#文档规则) 改写相关文档（改对应章节，不在文末追加），并更新 roadmap 状态。不要提交 node_modules、测试浏览器 profile、私有网页截图、密钥或导出的个人记忆。

欢迎 AI 辅助贡献，但提交者需要审查并理解修改，对测试结论负责。提交的贡献按本项目 MIT 许可证分发。
