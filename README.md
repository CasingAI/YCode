<p align="center">
  <img src="icon-source-1024.png" alt="YCode" width="128" height="128" />
</p>

<h1 align="center">YCode</h1>

<p align="center"><strong>ZCode 的社区修改版</strong><br />自托管 · 开源 · 面向开发 —— 保持官方体验一致的前提下，让它更好地服务多模型供应商与日常开发</p>

<p align="center">
  <img src="https://img.shields.io/badge/基于-ZCode-blue?style=flat-square" alt="基于 ZCode" />
  <img src="https://img.shields.io/badge/桌面-Electron-47848F?style=flat-square&logo=electron&logoColor=9FE2BF" alt="Desktop" />
  <img src="https://img.shields.io/badge/Web-React-20232A?style=flat-square&logo=react&logoColor=61DAFB" alt="Web" />
  <img src="https://img.shields.io/badge/Agent_CLI-Terminal-111111?style=flat-square" alt="Agent CLI" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-2ea44f?style=flat-square" alt="Apache-2.0" />
</p>

<p align="center">
  <a href="#理念">理念</a> ·
  <a href="#多模型供应商协作">多供应商</a> ·
  <a href="#opencode-集成">OpenCode</a> ·
  <a href="#web-与手机远控">Web 与远控</a> ·
  <a href="#体验与性能优化">体验与性能</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#路线图">路线图</a> ·
  <a href="#致谢与许可">致谢与许可</a>
</p>

---

YCode 是 [ZCode](https://github.com/zai-org/ZCode) 的社区分支，也是一份**自托管的 AI 编程工作台**。桌面版、Web 版与终端 Agent 全部在仓库中开源：代码、构建流程、会话数据都在你自己的机器上，模型请求发往你配置的供应商端点。使用官方 Coding Plan 模型时请求会经官方网关转发，各项数据流向与边界见 [NOTICE.md](NOTICE.md)。

在上游主干之上，YCode 把原本只服务于官方供应商的能力推广到每一个你在用的供应商，补齐以开发为中心的功能设计，接通手机与局域网的 Web 远控，并持续修复上游遗留问题、优化渲染与交互性能。

## 理念

| 原则         | 说明                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| 贴近官方原版 | 默认体验与 ZCode 官方保持一致，不做破坏性改造，便于随时与上游对比、同步官方更新                              |
| 多供应商协作 | 不增加供应商，而是让已被支持的供应商真正协同：额度、代理、上下文等能力按各家实际口径适配，而不是只服务官方一家 |
| 开发优先     | 功能设计以写代码这件事为中心，优先解决真实编码流程中的阻塞点，而不是堆叠通用功能                          |
| 细节更顺手   | 通过一批小功能优化、遗留问题修复与性能优化，让日常使用体验优于官方版本                                    |
| 开源自主     | 完整构建流程与运行时开源，可自行构建、审计与修改，代码与数据留在自己的环境中                                |

## 多模型供应商协作

ZCode 本身就支持十余个模型供应商，YCode 的重点不是增加供应商，而是**让这些已被支持的供应商真正协同起来**——把原本只有官方 provider 才享受得到的能力，推广到每一个你实际在用的供应商。

最典型的是**额度可见性**。在官方版本中，Z.AI / BigModel Coding Plan 可以在侧边栏和聊天输入框直接看到剩余额度与重置时间；换成其他已知供应商，界面就只剩模型名，用了多少还剩多少全靠猜。额度恰恰是决定「现在该不该切模型、该不该等下一轮窗口」的关键信息。YCode 把这条链路按供应商的实际口径补上，让非官方供应商也能拿到同等待遇。

其他被推广到各供应商的能力：

**三种协议原生适配**，不是简单的端点改写：

- `anthropic-messages` → Anthropic 风格端点
- `openai-responses` → OpenAI Responses 端点
- `openai-chat-completions` → OpenAI 兼容网关

**内置供应商**：Z.AI、BigModel / 智谱开放平台、Moonshot / Kimi、MiniMax、DeepSeek、Qwen（中国区 / 国际区）、Xiaomi MiMo、OpenAI、Anthropic、xAI、OpenRouter、OpenCode。

**自定义供应商**：可自由配置 API Key、`baseUrl`、自定义请求头、协议类型与模型清单，把自建网关或第三方兼容端点直接接入。

**按模型设置网络策略**：每个模型可独立选择跟随全局代理、使用 YCode 网络设置中的代理、使用系统代理或强制直连（`default` / `proxy` / `system` / `direct`）。不同供应商的端点往往在不同的网络位置，这条能力让它们可以混用而互不牵连；该设置只作用于该模型的推理请求，不影响 Bash、MCP、WebFetch 等其他网络出口。

**模型与上下文管理**：模型级配置支持启停、上下文窗口、输入输出能力、tool call、JSON Schema 输出、推理档位与最大输出长度；对话中可直接查询上下文余量并请求模型主动压缩。

## OpenCode 集成

YCode 目前与 [OpenCode](https://opencode.ai) 做了紧密结合，覆盖从接入到用量可见的完整链路。

- **内置接入模板**：提供 Go 与 Zen 两组端点 × Chat Completions / Messages / Responses 三种协议共 6 个模板，在设置页拥有独立的 OpenCode 分组、专属图标与文案，不会和「其他供应商」混在一起。
- **套餐额度查询**：通过 OpenCode Console 接口读取用量，展示滚动 5 小时、周、月三个窗口；凭据由本地凭据服务按 provider 隔离保存，查询只在 Host 进程发起，渲染进程通过 RPC 获取。
- **额度展示位置**：设置页的 OpenCode 卡片，以及聊天输入框的 context 浮层；切换到其他供应商时入口自动消失，未配置凭据时不产生任何网络请求。
- **请求归因**：识别 OpenCode 端点并附带会话标识请求头，便于用量与会话对应。

## Web 与手机远控

上游的 Web 版只以命令行发行包的形式存在：`zcode --web` 能跑，但桌面客户端里没有任何入口，不主动翻文档就等于不存在。YCode 补上了这一段，让 Web 变成一个真正会被用起来的能力。

- **桌面端一键开启**：在桌面端直接启动局域网访问，无需命令行发行包、无需手动构建 Web 产物。
- **手机浏览器直连同一个 Host**：手机或其他电脑的浏览器通过局域网连回桌面，复用桌面正在运行的 Host、工作区与 Agent 会话，而不是另起一套服务端。
- **连续性设计**：固定端口与令牌鉴权，首次令牌访问后转为长期 Cookie，重启自动恢复；断线重连保留页面、任务、草稿与导航状态，对有副作用的命令做 `commandId` 对账而不是盲目重放。
- **不依赖外部中转**：不经过 relay、配对码或隧道，连接建立在你自己的局域网内。

## 体验与性能优化

在保持官方交互逻辑的前提下，做了一批以开发体验为目标的改动。

| 方向       | 改动                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------- |
| 界面与密度 | 默认禁用导航条以显著提高性能；提高 Chat UI 信息密度；简化模式切换逻辑；优化模型名称显示；上下文占用统一为 K 单位 |
| 过程呈现   | Cursor 式过程收起；优化 Thinking 内容显示；优化调用轨迹显示；优化 Plan 卡片功能         |
| 模式与规划 | 支持 Ask 只读问答模式；优化与模型的模式沟通；优化 Plan 长期记忆能力                     |
| 工具与配置 | Bash 工具增加 Description 支持（含中文）；增加实验特性开关；启动时跳过初始化配置阶段 |
| 远程与网络 | 支持为特定模型单独设置网络代理策略；Web 入口与手机远控见上一节                           |

## 已修复问题

以下为已在上游代码中确认并修复的问题：

- [x] 修复 Conversation 排序时间不正确的问题
- [x] 修复 AskUserQuestion 时回答成功也显示“未提供回答”的渲染 bug
- [x] 修复 Responses 协议下无法显示思考内容
- [x] 修复 Thinking 耗时显示错误的问题

## 快速开始

### 环境要求

| 依赖                   | 版本      | 说明                                    |
| ---------------------- | --------- | --------------------------------------- |
| Git                    | 较新版本  | 必需                                    |
| [mise](https://mise.jdx.dev/) | 较新版本  | 工具版本以 [mise.toml](mise.toml) 为准 |
| Node.js                | `24.14.0` | 桌面端与 Agent 运行时                  |
| pnpm                   | `10.33.2` | workspace 包管理                       |

### 启动桌面版

```bash
# 首次运行或代码有更新：重建预编译产物
mise run start-build

# 直接用已有产物启动
mise run start
```

两个任务都会把数据写入独立的开发目录（`ZCODE_DATA_BASE_DIR`，默认 `~/.zcode-dev-home`），不会影响正式环境的数据。

### 日常开发

```bash
mise run dev                       # 桌面端，隔离的本地测试环境
mise run dev-desktop-prod          # 桌面端，生产服务配置
mise run dev-web                   # Web 端 + 后端

pnpm typecheck                     # 类型检查
pnpm lint                          # Lint
pnpm fmt:check                     # 格式检查
pnpm architecture:check --changed  # 架构边界检查
```

完整的初始化、打包与发布流程见上游文档：[ZCode 仓库 README](https://github.com/zai-org/ZCode#readme)。功能与交互的设计决策记录在 [docs/specs/](docs/specs/)。

## 路线图

- [ ] 集成 ZCode Stats
- [ ] 增加文件编辑器能力支持
- [ ] 为 AI 增加聊天搜索能力
- [ ] 修复编辑消息不会使用最新模型配置的问题

## 致谢与许可

- 上游项目：[zai-org/ZCode](https://github.com/zai-org/ZCode) —— 感谢官方开源的桌面端、Web 端与 Agent 运行时。
- 本仓库遵循 [Apache-2.0](LICENSE) 许可证。功能范围、数据处理与第三方组件声明见 [NOTICE.md](NOTICE.md) 与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
- AI 生成内容可能存在错误或遗漏，重要操作前请自行核查并保留可恢复的备份。
