# 参与贡献

欢迎提交可复现的问题、改进建议和 Pull Request。开始前请阅读 [AGENTS.md](AGENTS.md) 与 [架构](docs/architecture.md)，保持原生 JavaScript、MV3 与无运行时依赖的结构。

## 本地开发

1. 安装 Node.js 22+，执行 `npm ci --ignore-scripts --no-audit --no-fund`。
2. 在 Chrome / Edge 开发者模式加载 `extension/`。
3. 修改后重新加载扩展并刷新测试页。不要使用真实账号提交不可撤销的测试数据。
4. 执行 `npm test`、扩展脚本 `node --check` 和 `git diff --check`。浏览器检查见 [测试文档](docs/testing.md)。

## 提交问题

请提供浏览器版本、扩展版本、重现步骤、预期与实际结果。截图与日志先移除 API 密钥、Cookie、个人信息及站点敏感内容。安全漏洞不要公开提交，见 [SECURITY.md](SECURITY.md)。

## 提交修改

一次 PR 解决一个清楚的问题，说明行为变化、验证结果和未覆盖范围。新增有意义的变更请遵守 changelog 时间命名规则；同步相关使用文档和 roadmap。不要提交 node_modules、测试浏览器 profile、私有网页截图、密钥或导出的个人记忆。

欢迎 AI 辅助贡献，但提交者需要审查并理解修改，对测试结论负责。提交的贡献按本项目 MIT 许可证分发。
