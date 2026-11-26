# 目标模式 CDP 通道

状态：未实现。用于通用网页读取、输入与操作兼容；不是网站或支付表单专用动作。

## 权限与启用

- `debugger` 必须声明在 manifest 的 `permissions`，不能放进 `optional_permissions`。发布实现时同步 PRIVACY、安装/升级说明和权限验证；当前文档变更不修改 manifest。
- CDP 功能随目标模式默认关闭；用户开启目标模式即启用此能力，不另加一个产品开关。仅目标模式开启且当前执行标签可连接时，对本轮模型公开相应 function calling schema 和说明。普通模式不 attach、不公开工具；即使模型自行返回这些动作，后台也拒绝执行。
- 浏览器主机权限、任务站点范围、敏感字段授权保持独立；CDP 的更大技术访问范围不能替代这些产品门禁。

## 工具边界

- 模型使用当前快照目标 ID；后台映射为可信 tab/frame/session、文档、节点及命中点。目标模式只开放静态注册表内的通用读取、点击、填值、按键等工具。
- 不开放任意 CDP method/params、模型生成的选择器、HTML 或代码；模型脚本继续只允许经现有 run_script 与 userScripts 批准流程执行。
- 先实现 Accessibility/DOM 观察和 Input 输入，再适配跨进程 iframe 的 Target 子会话与导航失效。截图与视觉输入另行评估，不作为已有能力。
- 工具暴露、上下文预算、原生调用与 JSON 回退共用能力判定和校验；不可用时返回明确 code，不反复尝试连接或授权。

## 生命周期与恢复

- 仅连接当前任务的执行标签，绑定任务 ID、代次、来源、文档与子框架身份。切换执行标签、导航或框架变化后重新观察。
- 停止、接管、任务结束、关闭 CDP 或退出目标模式后停止派发并 detach，丢弃迟到结果。处理用户取消调试、DevTools 占用和浏览器断连；不自动重连后重放输入。
- 副作用前写 executing 检查点。回执丢失或 worker 中断后只读核对或暂停，保持原 deadline；目标模式的普通阻碍恢复仍最多 3 次。

## 实施顺序

- [ ] 权限声明、沿用目标模式开关、能力检测、仅目标模式公开工具。
- [ ] 静态动作注册、快照 ID 映射、通用 DOM/AX 读取与 Input 执行。
- [ ] 子 target/session、跨源框架门禁、导航及过期目标处理。
- [ ] 停止/接管/detach/丢回执/worker 中断验证，以及真实网页和真实模型验收。

## 验收范围

验证普通模式不暴露也不执行；启用/关闭和模式变化使旧调用失效；网站权限、任务范围与敏感授权不能被绕过；遮挡、框架导航、执行标签切换、停止、接管和调试断连都不误派发或重放。用合成结账表单验证只填写、核对并停在最终提交前，真实网站和模型结果单独报告。

参考：[Chrome permissions 的可选权限限制](https://developer.chrome.com/docs/extensions/reference/api/permissions)、[chrome.debugger 与子会话](https://developer.chrome.com/docs/extensions/reference/api/debugger)。
