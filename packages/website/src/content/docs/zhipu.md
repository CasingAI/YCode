智谱是 YCode 的官方支持供应商，内部对应两个供应商族：**Z.AI**（`zai`）与 **BigModel 智谱开放平台**（`bigmodel`）。官方支持意味着完整接入的不只是端点，还包括账号登录、Coding Plan 套餐状态与**套餐额度查询**——额度是判断「现在该不该切模型、该不该等下一轮窗口」的关键信息。

## 内置接入模板

| 模板                    | 说明                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `zai-api`               | Z.ai Coding Plan（API Key 方式，Anthropic Messages 协议，端点 `api.z.ai/api/anthropic`） |
| `zai-standard-api`      | Z.AI 标准 API（按量付费）                                                                |
| `bigmodel-api`          | BigModel Coding Plan                                                                     |
| `bigmodel-standard-api` | BigModel 开放平台标准 API                                                                |

Coding Plan 与标准 API 走的是不同的接入类型：Coding Plan 的 Key 与订阅绑定，额度受套餐约束；标准 API 是常规按量计费。

## 账号登录与订阅绑定

- 支持账号 OAuth 登录（Z.AI / BigModel 各自一套 OAuth 身份），登录后无需手工粘贴 Key。
- 登录态下 Coding Plan 订阅作为**模型供应商条目**呈现，BigModel 支持起始套餐、个人 Coding Plan 与团队 Coding Plan 等订阅形态；订阅变更会同步到模型列表。
- 设置页与侧边栏都能看到 Coding Plan 的套餐状态与额度。YCode 不提供购买或升级入口，额度不足时按提示等待窗口重置，或到供应商侧自行处理。

## 套餐额度与重置窗口

Coding Plan 有两个重置周期：**5 小时窗口**与**周窗口**。额度信息在三个位置可见：

- **侧边栏套餐徽章与摘要**：当前套餐、剩余额度与最近一次重置倒计时。
- **剩余额度面板**：展示用量、限额与重置时间（`CodingPlanUsageRemainingPanel`）。
- **聊天输入框**：上下文浮层与提示条里直接显示套餐用量（`CodingPlanContextUsage`、起始套餐余额条 `StartPlanContextBalance`）。

额度数据由官方套餐链路（usage stats 服务）提供，**只服务 Z.AI / BigModel Coding Plan**——其它供应商即使内置接入也不会出现在这条链路里（见[其他内置供应商](/docs/providers)）。

## 数据流向

使用官方 Coding Plan 模型时，推理请求经官方网关转发；会话数据、代码与构建流程仍留在本机，完整边界见仓库 NOTICE.md。
