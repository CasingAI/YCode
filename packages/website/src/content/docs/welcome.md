YCode 是 [ZCode](https://github.com/zai-org/ZCode) 的社区分支，也是一份**自托管的 AI 编程工作台**。桌面版、Web 版与终端 Agent 全部在仓库中开源：代码、构建流程、会话数据都在你自己的机器上，模型请求发往你配置的供应商端点。使用智谱 Coding Plan 模型时，请求会经智谱网关转发，各项数据流向与边界见仓库内的 NOTICE.md。

在上游主干之上，YCode 把额度、代理、上下文这类原本只按官方口径实现的能力，按各家供应商的实际接口逐个适配，补齐以开发为中心的功能设计，接通手机与局域网的 Web 远控，并持续修复上游遗留问题、优化渲染与交互性能。

其中五家供应商能在应用内直接看到账户的配额或余额：[智谱 Z.AI / BigModel](/docs/zhipu)、[OpenCode](/docs/opencode)、[MiniMax Token Plan](/docs/minimax-token-plan)、[DeepSeek](/docs/deepseek)、[OpenRouter](/docs/openrouter)。它们各自需要什么凭据、显示哪几项数字，见各页说明。其余内置供应商提供的是接入：能连、能用，用量需自行去各家控制台查看。

## 理念

| 原则         | 说明                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------- |
| 贴近官方原版 | 默认体验与 ZCode 官方保持一致，不做破坏性改造，便于随时与上游对比、同步官方更新          |
| 多供应商协作 | 不增加供应商，而是让已被支持的供应商真正协同：额度、代理、上下文等能力按各家实际口径适配 |
| 开发优先     | 功能设计以写代码这件事为中心，优先解决真实编码流程中的阻塞点                             |
| 细节更顺手   | 通过一批小功能优化、遗留问题修复与性能优化，让日常使用体验优于官方版本                   |
| 开源自主     | 完整构建流程与运行时开源，可自行构建、审计与修改，代码与数据留在自己的环境中             |

## 一套仓库，三种形态

- **桌面端**：Electron 应用，负责窗口、原生操作与 Host 进程调度；本地工作区通过窗口级的 Local Host 与 Agent 通信。
- **Web 端**：浏览器访问同一套服务；手机或其他电脑的浏览器可以经局域网直连桌面正在运行的 Host，复用同一个工作区与会话，详见 [Web 与手机远控](/docs/remote)。
- **Agent CLI**：终端里的 Agent 运行时，同时也是桌面端的 Agent 内核；技能、命令、Hooks、MCP、插件等扩展机制都运行在这一层，见[插件](/docs/plugins)分组。

## 这份文档怎么读

- 新手从[安装与启动](/docs/install)开始，然后看[配置](/docs/configuration)了解用户级与工作区级的资源放在哪里。
- 想了解日常核心体验，读[目标模式](/docs/goal)、[计划模式](/docs/plan)、[子代理](/docs/subagents)与[上下文与压缩](/docs/context)。
- 想接入模型：能直接看到配额或余额的五家各有说明——[智谱 Z.AI / BigModel](/docs/zhipu)、[OpenCode](/docs/opencode)、[MiniMax Token Plan](/docs/minimax-token-plan)、[DeepSeek](/docs/deepseek)、[OpenRouter](/docs/openrouter)；其余内置供应商与自定义端点见[内置供应商与自定义端点](/docs/providers)，出口策略见[网络与代理](/docs/network)。
- 遇到问题先查[常见问题](/docs/faq)；设计决策的完整记录在仓库 `docs/specs/` 目录。
