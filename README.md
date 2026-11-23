<div align="center">
  <img src="extension/icons/logo.svg" width="80" height="80" alt="Page Agent Lite logo">
  <h1>Page Agent Lite</h1>
  <p><strong>一句话，让网页开始行动。</strong></p>
  <p>AI驱动的轻量浏览器插件，能持续自动化帮你处理浏览器事物</p>
  <p>
    <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-244b3b?style=flat-square"></a>
    <img alt="Chrome and Edge" src="https://img.shields.io/badge/Chrome%20%2F%20Edge-MV3-5b7850?style=flat-square">
    <img alt="No build required" src="https://img.shields.io/badge/build-not%20required-a9c58a?style=flat-square">
  </p>
  <p><a href="#快速开始">快速开始</a> · <a href="docs/usage.md">使用指南</a> · <a href="ROADMAP.md">Roadmap</a> · <a href="CONTRIBUTING.md">参与贡献</a></p>
</div>

---

在浏览器侧栏说出目标，助手读取网页、填写表单、点击和翻页，再检查实际结果。使用你现有的登录状态和自己的模型 API，无需 Python、独立后端或构建步骤。

> 项目处于早期，关注原生扩展、任务恢复、结果核对与本机记忆。请按真实页面核对操作结果。

<div align="center"><img src="docs/assets/sidepanel-preview.png" width="360" alt="Page Agent Lite 侧栏示例界面"></div>

<sub>预览使用合成示例数据，不代表真实模型执行结果。</sub>

## 能做什么

| 能力 | 当前实现 |
| --- | --- |
| 网页操作 | 读取顶层 DOM；填写、勾选、选择、点击、悬停、滚动、滚轮、按键、双击、右键；长页面分段读取 |
| 持续任务 | 中途补充指令、停止、我来操作后继续；在任务授权的站点间单标签导航 |
| 结果核对 | 等待网页反馈，核对字段、区域、URL 条件；结果不明时不重放操作 |
| 记忆 | 会话内临时笔记；IndexedDB 网站/全局长期笔记，可查看、编辑、导出 |
| 长任务 | 按上下文预算压缩旧过程，原始结果可按需读取 |
| 模型 | 非流式 OpenAI Chat Completions 兼容接口，支持本机服务 |

## 快速开始

1. 克隆本仓库。
2. 打开 `chrome://extensions` 或 `edge://extensions`，开启开发者模式。
3. 「加载已解压的扩展程序」，选择 **extension/** 文件夹。
4. 打开扩展「设置」，填写 API 基础地址、模型和密钥，授权并保存。
5. 在普通网页点击工具栏图标打开侧栏，授权当前网站（或全部网页），输入目标。

```text
读取这页内容，帮我整理成几个要点。
按我提供的信息填写表单，提交前让我检查。
逐页查看这些条目，找出符合条件的内容。
```

需要 Chrome / Edge 120+，模型需能稳定输出 JSON。更新源码后重新加载扩展并刷新网页。只提供源码，不发布 ZIP 或商店包。完整说明见 [使用指南](docs/usage.md)。

## 你的数据去哪了

- 目标、页面文字和普通表单内容会发送到你配置的模型服务；费用和数据政策由该服务决定。密码、文件、隐藏字段及带标准 autocomplete 标记的验证码/卡号字段会被排除，但不能保证识别所有隐私。
- API 密钥只由扩展后台使用。没有遥测，也没有项目自己的云端。
- 任务和临时笔记只在本次浏览器会话中；长期笔记存在本机 IndexedDB，卸载或清理扩展数据会丢失，请导出备份。

详见 [隐私说明](PRIVACY.md)。

## 边界

- 自动执行包括提交、删除等按钮；可随时停止，已发出的操作不会撤销。
- 不支持图片/画布、iframe、Shadow DOM、复杂富文本编辑器、多标签协作，也不跨浏览器重启恢复任务。
- 合成事件不等于真实鼠标键盘；部分网站会忽略。字段核对只证明页面上的值，不证明业务正确或服务器已保存。
- 模型可能误判。不要仅凭功能列表推断所有网站都能稳定执行，验证状态见 [Roadmap](ROADMAP.md)。

## 开发

运行扩展不需要安装依赖；测试需要 Node.js 22+：`npm ci --ignore-scripts --no-audit --no-fund && npm test`。

[贡献指南](CONTRIBUTING.md) · [架构](docs/architecture.md) · [测试](docs/testing.md) · [安全](SECURITY.md) · [Changelog](changelog/README.md) · [同类项目](docs/competitive-landscape.md)

## 许可与参考

代码采用 [MIT License](LICENSE)。侧栏鲸鱼娘插画单独采用 CC BY-NC-SA 4.0（署名、非商业、相同方式共享），不属于 MIT 授权，见 [素材说明](extension/licenses/README.md)。

运行器与上下文设计参考了 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的公开文档，网页执行能力参考了 [alibaba/page-agent](https://github.com/alibaba/page-agent)；本项目不依赖它们的运行时。
