<div align="center">
  <img src="extension/icons/logo.svg" width="80" height="80" alt="Page Agent Lite logo">
  <h1>Page Agent Lite</h1>
  <p><strong>一句话，让网页开始行动。</strong></p>
  <p>一个轻量、可配置、有记忆的 Chrome / Edge 网页助手。</p>
  <p>
    <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-244b3b?style=flat-square"></a>
    <img alt="Chrome and Edge" src="https://img.shields.io/badge/Chrome%20%2F%20Edge-MV3-5b7850?style=flat-square">
    <img alt="No build required" src="https://img.shields.io/badge/build-not%20required-a9c58a?style=flat-square">
  </p>
  <p><a href="#快速开始">快速开始</a> · <a href="docs/usage.md">使用指南</a> · <a href="ROADMAP.md">Roadmap</a> · <a href="CONTRIBUTING.md">参与贡献</a></p>
</div>

---

在浏览器侧栏说出目标，助手读取网页、填写表单、点击和翻页，再检查实际结果。使用你现有的登录状态和自己的模型 API，无需 Python、独立后端或构建步骤。

> 项目关注原生扩展、任务恢复、结果核对与本机网站记忆。目前处于早期，请按真实页面反馈核对操作结果。

<div align="center"><img src="docs/assets/sidepanel-preview.png" width="360" alt="Page Agent Lite 侧栏示例界面"></div>

<sub>预览使用合成示例数据展示界面，不代表真实模型执行结果。</sub>

## 能做什么

| 能力 | 当前实现 |
| --- | --- |
| 自然语言操作 | 读取顶层 DOM，填写、勾选、选择、点击及滚动 |
| 持续任务 | 同站翻页继续，中途补充指令，停止与手动结束分开 |
| 结果核对 | 等待网页反馈、核对字段和区域条件；结果不明时避免重放操作 |
| 网站记忆 | IndexedDB 本机保存，跨任务/标签页/重启共享，按需读取，可编辑和导出 |
| 长任务上下文 | 按预算压缩旧过程，保存摘要和可按需读取的原始结果 |
| 自选模型 | 非流式 OpenAI Chat Completions 兼容接口，支持本机兼容服务 |
| 执行控制 | 默认点击需确认，可开启自动点击；默认 50 轮，0 表示不限 |
| 文章辅助 | 选区翻译、段落摘要和受限样式修改 |

## 快速开始

1. 克隆本仓库，或下载源码并解压。
2. 打开 `chrome://extensions` 或 `edge://extensions`，开启开发者模式。
3. 点击「加载已解压的扩展程序」，选择仓库中的 **extension/** 文件夹。
4. 打开扩展「设置」，填写 API 基础地址、模型名称和密钥，授权并保存。
5. 回到普通网页，点击工具栏图标打开侧栏，授权当前站点并输入目标。

```text
读取这页内容，帮我整理成几个要点。
按我提供的信息填写表单，提交前让我检查。
逐页查看这些条目，找出符合条件的内容。
记住这个网站经过核实的操作流程，下次按需参考。
```

模型需要支持可靠的 JSON 输出。浏览器最低版本声明为 120，另需支持 local 存储访问隔离 API；推荐使用新版 Chrome / Edge。更新源码后重新加载扩展并刷新网页。当前提供源码，不发布 ZIP 或浏览器商店安装包。

## 你的数据去哪了

- 目标、页面文字和普通表单内容会发送到你配置的模型服务，API 费用与服务商数据政策由该服务决定。
- API 密钥仅由扩展后台使用；配置存在本机，网站长期笔记存在扩展 IndexedDB。没有遥测或项目自己的云端。
- 任务与临时记忆保存在浏览器会话中；网站长期笔记可跨重启保留。卸载或清理扩展数据可能删除笔记，请导出备份。
- 同一网站的不同登录账号共用网站笔记；不支持自动区分账号。不会自动保存整段对话为长期记忆。

详细说明见 [隐私说明](PRIVACY.md) 和 [使用指南](docs/usage.md)。

## 边界

支持顶层文字 DOM，不支持图片/画布、iframe、Shadow DOM、富文本、多标签页协作或跨站任务。页面读取有容量上限；填写核对不代表业务正确或服务器保存成功。模型可能误判，也可能遗漏需要确认的操作。

这是可运行的探索项目，不等于完整 Hermes Agent。近期重点与验证状态见 [Roadmap](ROADMAP.md)，不要仅凭功能清单推断所有网站都可稳定执行。

## 开发与贡献

运行扩展不需要安装依赖。仅开发测试需要 Node.js 22+：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

- [贡献指南](CONTRIBUTING.md) · [安全问题](SECURITY.md)
- [架构](docs/architecture.md) · [运行器](docs/agent-runtime.md) · [网页工具](docs/browser-tools.md)
- [上下文与记忆](docs/context-and-skills.md) · [存储](docs/storage.md) · [测试](docs/testing.md)
- [Changelog](changelog/README.md) · [同类项目](docs/competitive-landscape.md)

## 许可与参考

采用 [MIT License](LICENSE)。欢迎使用、修改和贡献，请保留许可证与版权声明。

运行器与上下文设计参考了 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的公开文档。项目采用独立设计的界面与图标。
