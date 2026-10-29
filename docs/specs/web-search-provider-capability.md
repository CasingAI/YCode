# Spec: 网络搜索 Provider 体系（独立搜索 API 接入）

## 目标

把 WebSearch 工具的执行后端从"模型原生 web_search server tool"（仅 Anthropic Messages 协议可编码，行为不透明）替换为**按供应商配置的独立搜索 API**。用户在「设置 → Agent 能力 → 网络搜索」页管理候选搜索源与优先级，排第一的激活；CLI 运行时用该供应商已配置的同一把 API Key 直接调用其独立搜索端点。

内置支持五个搜索源：四个与内置聊天供应商模板绑定（实例来自供应商设置/登录引导），另有一个独立的 `jina` 搜索源模板（实例只能在网络搜索页手动添加）：

| 模板 templateId      | 端点                                                                               | Key                                         |
| -------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| `deepseek`           | `POST https://api.deepseek.com/v1/tools/search`                                    | 普通 API Key，按量计费（2026-11-01 起收费） |
| `minimax-token-plan` | `POST https://api.minimaxi.com/v1/coding_plan/search`（国际 `api.minimax.io`）     | Token Plan `sk-cp-` Key，含在套餐额度       |
| `bigmodel-api`       | MCP `https://open.bigmodel.cn/api/mcp/web_search_prime/mcp`，工具 `webSearchPrime` | Coding Plan Key，套餐 MCP 额度              |
| `zai-api`            | MCP `https://api.z.ai/api/mcp/web_search_prime/mcp`，工具 `webSearchPrime`         | Coding Plan Key，套餐 MCP 额度              |
| `jina`               | `POST https://s.jina.ai/{encodeURIComponent(query)}`，`respondWith: "no-content"`  | Jina API Key，按量计费                      |

## 产品规则

- 搜索源自动识别：个人 provider 的 `templateId ∈ WEB_SEARCH_CAPABLE_PROVIDER_TEMPLATE_IDS` 即为候选；`templateId` 缺失时按 `api.baseUrl` 签名回退匹配。识别逻辑 UI 与 CLI 共用同一个 shared 常量，不允许第二份名单。
- MiniMax（按量）、BigModel API、Z.ai API 等标准模板不是搜索源：其 Key 调不通上述端点，不进入候选。
- `jina` 是内置「独立搜索源」模板：search-only，无任何聊天模型（模板不带 `builtinModelIds`），不进登录引导（quota 模板白名单不含）与模型选择器；实例只能从「网络搜索」页添加。
- 「网络搜索」页提供「添加 Jina」按钮：每次点击创建一个新的个人 provider 实例（`templateId: "jina"`、`standard-personal` 组），实例名按模板名自动去重（Jina、Jina-2…），**允许重复添加**；创建后自动打开该实例的设置模态引导配 Key。
- jina 实例行的设置按钮打开模态，配置：API Key（附模板 `access.apiKeyManagementUrl` 的获取 Key 链接）、出站代理模式（`default`（跟随网络设置）/ `proxy`（强制走网络分区代理）/ `direct`（强制直连），语义与 per-provider `proxyMode` 一致，唯一事实在 provider rule，不新增第二份代理配置），以及删除实例。
- jina 实例与其他搜索源共用排序、激活与快照语义；Key 非空才可被激活，按量计费（`billing: "per-call"`）。
- 设置页展示候选列表，支持拖拽与上下移动排序；新出现的候选追加尾部；**排第一的激活使用**。
- `AppSettings.webSearchProviderOrder` 未初始化（字段缺省）时按固定优先级派生默认序：Z.ai Coding Plan → BigModel Coding Plan → MiniMax Token Plan → DeepSeek（套餐内优先、按量靠后）。派生结果在用户首次修改排序时才落盘；派生函数只有一份，UI 展示与 CLI 执行共用。
- `AppSettings.webSearchEnabled` 总开关缺省 `true`；开关关闭、候选为空、或激活项无法解析（provider 已删除 / 无 apiKey）时，WebSearch 工具不暴露。
- 策略（开关+排序）在会话 app 创建/恢复边界一次性快照绑定进 `WebSearchPort`；设置切换只影响之后创建/恢复的会话，已活跃会话的工具面与激活搜索源不随开关实时翻转（与 dynamic-workflow / off-peak 策略同构：只影响之后创建/恢复的 record）。正在执行的调用不中断。
- WebSearch 的输入 schema、权限模型（permission `websearch`、无需审批、只读、READ_ONLY_TOOLS 归类）保持不变；输出 schema 唯一扩展是 `results[].snippet`（可选，独立搜索 API 的结果摘要，原生路径没有）；模型可见内容改为「Results 列表 + 标题/链接/日期/摘要」，按小写 url 去重。
- 旧的原生路径彻底移除：`supportsNativeWebSearch` 模型能力属性、tool-transform 的 `web_search_20260209` 编码、handler 内部 `model.streamText` + providerNative 构造、以及针对 BigModel Anthropic 兼容端点的 1210 / 裸 tool_result workaround 全部删除。旧配置文件中的遗留字段由 schema 非严格解析剥离。
- WebSearch 工具卡与进行态文案不变；设置页 DeepSeek 行展示按量计费提示，MiniMax 行标注需 Token Plan Key。
- 后果声明：Anthropic（api.anthropic.com）原生 web_search 随旧路径移除，不在四个内置搜索源内，升级后 Anthropic 模型不再提供 WebSearch。

## 状态所有者与事件顺序

```text
AppSettings.webSearchEnabled / webSearchProviderOrder（~/.ycode/v2/setting.json，持久化唯一事实源）
  → 设置页 useSettings().update（排序/开关写入）
  → settingService 原子落盘 → platform.syncAppSettings 刷新本窗口
  → zcodeAgentService.syncAppRuntimePreferences → workspace/updateWebSearchPolicy（按 workspace 串行）
  → CLI handler 写 context.appRuntimePreferences（进程内缓存，仅推送时更新）
  → 会话 app 创建/恢复边界把当前策略快照绑定进 WebSearchPort（app 生命周期内恒定）
  → 模型调用 WebSearch → core executor → handler
  → 读快照偏好（开关+顺序）→ personal provider config（CLI 已加载，Key 事实源）解析端点/Key
  → registry → REST / MCP 适配器 → 供应商搜索 API → 归一化 WebSearchOutput
  → 其它窗口经 appRuntimePreferencesChanged 广播只读重渲染，不再二次写盘（防回环沿用既有链路）
```

1. 排序/开关的唯一事实源是 `setting.json`；provider 实例与 Key 的唯一事实源是 `provider_config.json`（本任务不改其结构）。
2. CLI 偏好缓存只在收到推送时更新；会话 app 创建/恢复时把策略快照绑定进 WebSearchPort，WebSearch 执行读会话快照，无轮询、无定时器。
3. 激活项解析失败（provider 删除、无 Key）按"不暴露工具"处理，不抛运行时错误。
4. 旧 CLI（不认识 `workspace/updateWebSearchPolicy`）由 host 按 method-not-found 降级忽略；旧 host 未推送时 CLI 缺省为"无搜索源"，即不暴露 WebSearch。

## 接口与实现边界

- `packages/shared/src/provider-search-capability.ts`：`WEB_SEARCH_CAPABLE_PROVIDER_TEMPLATE_IDS` 与模板 → 搜索端点描述（kind: `rest` | `mcp`、endpoint、toolName）的唯一映射；UI 与 CLI 共用。
- `packages/shared/src/validationAppSettings.ts`：`webSearchEnabled`（默认 `true`）与 `webSearchProviderOrder`（`string[]`，缺省未初始化）进入 full schema 与 patch schema。
- `packages/shared/src/app-runtime-preferences.ts`：广播 payload 增加两字段，`.strict()` 校验同步更新。
- `packages/shared/src/zcode-protocol/index.ts`：新增 `workspace/updateWebSearchPolicy` 方法与 params/result strict schema；归入 `zcodeProtocolMethods`。
- `packages/services/src/zcode-agent/zcodeAgent.ts` 与 `zcodeAgentService.ts`：`ZCodeAgentAppRuntimePreferences` 增字段；`syncAppRuntimePreferences` 增加推送；旧 CLI method-not-found 降级忽略。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/web-search-policy.ts`：新协议 handler（`parseParams` → `context.appRuntimePreferences`）；`server.ts` dispatch、`server-types.ts` 缺省值。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/web-search-port.ts`：`createPolicyWebSearchPort` 把偏好视图装配成 `WebSearchPort`；`createSessionPolicyWebSearchPort` 在 app 创建/恢复边界对策略（开关+排序）做快照绑定，会话生命周期内不再读实时 context。
- `apps/zcode-cli/packages/contracts`：`WebSearchPort` 端口类型（`resolveActiveProvider(): ActiveWebSearchProvider | undefined` + `search(input, provider, { abortSignal }) → WebSearchOutput`），复用现有 `WebSearchInputSchema/OutputSchema`；`ActiveWebSearchProvider` 携带端点描述与该 provider 实例的 `proxyMode`。
- `apps/zcode-cli/packages/adapters/src/web-search/`：`common.ts`（fetchJson / 60s 超时 / 域名过滤与去重 / 输出归一化）、`deepseek-rest.ts`、`minimax-rest.ts`、`jina-rest.ts`（`POST {endpoint}{encodeURIComponent(query)}`，body `respondWith: "no-content"` 只取摘要不抓正文，映射 `data[]` 的 `title/url/description`）、`zhipu-mcp-search.ts`（StreamableHTTP + Bearer，按 endpoint|apiKey|proxyMode 池化）、`executor.ts`（`createRegistryWebSearchExecutor`：从进程级 Provider Registry 按偏好解析激活源，并按 `proxyMode` 缓存 proxy-aware fetch）。错误分类为可恢复工具失败并透传供应商信息。
- `apps/zcode-cli/packages/core`：`config.ts` 的 `getTools`/`shouldExposeWebSearch` 改为按"开关 + 激活搜索源可解析"门控（去掉 model 依赖）；`handlers/websearch.ts` 改调注入的 `WebSearchExecutor`；`websearch-results.ts` 删除 Anthropic 形状识别。
- `packages/ui`：`settingsNavigation.ts` 新增 `webSearch` 分区 id（basics 组已有 `network`，不得撞名）；`settingsPageConfig.ts` 在 agentCapabilities 组注册；`SettingsPage.tsx` 增渲染分支；新组件 `settings/WebSearchSettingsSection.tsx` 用 dnd-kit 可排序行实现拖拽 + 上/下按钮排序，排序经 `resolveWebSearchProviderOrder` 合并后提交 `update({ webSearchProviderOrder })`；jina 实例行带设置按钮，模态 `settings/WebSearchJinaSettingsDialog.tsx`（Key / 出站代理 / 删除）经 `providerSettingsService` 现有 `savePersonalProviderOverlay`（稀疏 overlay + `proxyModeUpdate` 元数据）与 `deletePersonalProvider` 持久化，不新增写入路径；i18n 双语 `settings.webSearch.*`。
- `config/provider/zcode-builtin.json`：`templateRules` 新增 `jina` 模板（`access.type: "api-key"` + `apiKeyManagementUrl`、`api.baseUrl: "https://s.jina.ai"`、builtin logo `jina`，缺资源时 UI 回退通用图标；不带 `builtinModelIds`）；该模板不含 `supportsNativeWebSearch` 等模型能力字段。
- 旧路径清理范围：`tool-transform.ts`、`runner-options.ts`、`model-execution.ts` 相关分支；`supportsNativeWebSearch` 从 `packages/shared/src/model-config.ts`、`packages/provider`（resolver、manual-model-config）、`config/provider/zcode-builtin.json`（5 条规则）、UI ProviderModelMetadata/Dialog/DraftState、双语 i18n 与相关测试中移除。

## 验收场景

1. 添加 DeepSeek 供应商（配置 Key）后，「网络搜索」页自动出现该候选且排第一（唯一候选时）；会话内 WebSearch 调用 `POST /v1/tools/search` 并返回归一化结果。
2. 添加四家中的多家时按固定优先级派生默认序；拖拽/上下移动后第一名变化，之后创建/恢复的会话使用新激活项，已活跃会话保持创建时的激活项。
3. 总开关关闭后，之后创建/恢复的会话不再暴露 WebSearch 工具；已活跃会话的工具面保持创建时状态，重新打开会话后生效。
4. 未添加任何搜索源供应商时页面展示空态引导；WebSearch 不暴露（含 Anthropic 模型）。
5. 激活项 Key 被清空或 provider 删除后，WebSearch 不暴露；页面行内出现警示。
6. MiniMax（按量）模板的 provider 不出现在候选中；MiniMax Token Plan 出现并标注需 Token Plan Key。
7. 旧 CLI 连接新 host：host 推送被降级忽略，不报错；旧 setting.json 无新字段时按缺省解释（开关开、顺序未初始化）。
8. 点击「添加 Jina」即创建一个新实例并进入候选列表（未配 Key 时行内警示、不可被激活），设置模态自动打开；重复点击得到 Jina、Jina-2 等多实例，Key/代理互相独立。
9. jina 实例在模态保存 Key 并排序到第一后，之后创建/恢复的会话激活 jina：WebSearch 调用 `POST https://s.jina.ai/{query}` 并返回归一化结果；删除实例后从候选移除，排序中残留 id 被剔除，激活项顺延。
10. jina 模板不出现在模型供应商添加目录、登录引导与模型选择器；供应商设置页可见实例本身（可改名/删除）。
11. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 与新增单测（adapters/core/bootstrap/shared）全部执行并报告真实结果。

## 负面边界

- 不做自定义搜索源接入（仅五个内置模板，jina 也只按内置模板实例化，不开放任意端点/任意模板接入）；不接 DeepSeek `/v1/tools/fetch`；WebFetch 行为不变。
- 不做搜索配额、并发、重试策略管理与用量统计面板改动。
- 不修改 provider_config.json 结构与供应商设置流程；不新增持久化文件。
- 不改变 WebSearch 权限、审批、结果预算与工具卡文案；不动 subagent 工具清单结构。
- 不在 UI 直接调用搜索端点（执行只发生在 CLI 运行时）。
