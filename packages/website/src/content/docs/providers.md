YCode 内置了一批供应商的接入模板：填 Key 即可用，端点、模型清单与请求格式都已预置。

其中五家还能在应用内直接看到账户的配额或余额：

- [智谱 Z.AI / BigModel](/docs/zhipu)：Coding Plan 套餐额度与两个重置窗口。
- [OpenCode](/docs/opencode)：Go 套餐用量与 Zen 余额。
- [MiniMax Token Plan](/docs/minimax-token-plan)：订阅配额的两个窗口。
- [DeepSeek](/docs/deepseek)：开放平台账户余额。
- [OpenRouter](/docs/openrouter)：账户积分余额。

其余内置供应商只提供接入：在设置页能连、能用，但用了多少、还剩多少要自行去各家控制台看。

## 内置供应商

Moonshot / Kimi、MiniMax（另有独立的 Token Plan 模板）、DeepSeek、Qwen（中国区 / 国际区）、Xiaomi MiMo、OpenAI、Anthropic、xAI、OpenRouter。

## 三种协议原生适配

内置模板不是简单的 URL 改写，而是按协议完整适配：

- `anthropic-messages` → Anthropic 风格端点
- `openai-responses` → OpenAI Responses 端点
- `openai-chat-completions` → OpenAI 兼容网关

## 自定义供应商

除内置清单外，可以把自建网关或第三方兼容端点直接接入：自由配置 API Key、`baseUrl`、自定义请求头、协议类型与模型清单。

## 模型级配置

每个模型可以单独设置：启用/停用、上下文窗口大小、输入输出能力、tool call 支持与否、JSON Schema 输出、推理档位与最大输出长度。对话中可以直接查询上下文余量并请求模型主动压缩（见[上下文与压缩](/docs/context)）。

## 出口与用量查询

- 不同供应商的端点往往位于不同网络位置，每个模型可独立设置出口策略（跟随全局 / 强制代理 / 系统代理 / 强制直连），互不牵连，详见[网络与代理](/docs/network)。
- 某个供应商如无内置额度查询，可选方案是给它写一个 [MCP](/docs/mcp) 服务器或 [Hook](/docs/hooks)：在工具调用前后拉取控制台用量并注入上下文。这属于社区玩法，YCode 本身不内置。
