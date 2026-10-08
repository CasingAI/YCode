OpenCode（opencode.ai）在 YCode 里可以查询套餐用量：Go 与 Zen 两组端点的接入模板已经预置，填好凭据后用量直接显示在应用里，不用切到浏览器查控制台。

## 内置接入模板

Go 与 Zen 两组端点 × Chat Completions / Messages / Responses 三种协议，共 6 个模板。设置页里 OpenCode 有自己的分组、图标与文案。

## 套餐额度查询

- 通过 OpenCode Console 接口读取用量，展示**滚动 5 小时、周、月**三个窗口。
- 设置页的 OpenCode 卡片里粘贴整段 Cookie 后，Workspace 改为下拉选择（留空即自动取默认）；Cookie 与所选 Workspace 由本地凭据服务隔离保存。
- 查询只在 Host 进程发起，渲染进程通过 RPC 获取；未配置凭据时**不产生任何网络请求**。内存缓存 60 秒节流。

## 额度展示位置

- 设置页的 OpenCode 卡片。
- 聊天输入框的 context 浮层（切到未配置该供应商的会话时入口自动消失）。

## 请求归因

识别 OpenCode 端点并附带会话标识请求头，便于把用量与会话对应起来。

## 相关页面

- 协议与模型配置的通用说明见[内置供应商与自定义端点](/docs/providers)。
- OpenCode 端点的网络出口同样适用按模型代理策略，见[网络与代理](/docs/network)。
