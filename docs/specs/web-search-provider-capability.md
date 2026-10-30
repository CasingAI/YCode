# Spec: 网络搜索 Provider 体系（独立搜索 API 接入）

## 目标

把 WebSearch 工具的执行后端从"模型原生 web_search server tool"（仅 Anthropic Messages 协议可编码，行为不透明）替换为**按供应商配置的独立搜索 API**。用户在「设置 → Agent 能力 → 网络搜索」页管理候选搜索源与优先级，排第一的激活；CLI 运行时用该供应商已配置的同一把 API Key 直接调用其独立搜索端点。

内置支持五个搜索源：四个与内置聊天供应商模板绑定（实例来自供应商设置/登录引导），另有独立搜索源模板（实例只能从网络搜索页手动添加；当前唯一允许的独立模板是 `jina`）。搜索源按模板元数据分两类，UI 不得内联具体模板 id：

- `chat-provider`：与聊天供应商模板共用一个实例，配置好该聊天供应商后自动识别为搜索源。
- `independent`：独立搜索源模板，一个模板可创建多个实例；`source` 为 `independent` 即表示只从「添加搜索源」目录手动实例化，目前仅 `jina`。

| 模板 templateId      | 来源类型        | 可手动添加 | 端点                                                                               | Key                                         |
| -------------------- | --------------- | ---------- | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| `deepseek`           | `chat-provider` | 否         | `POST https://api.deepseek.com/v1/tools/search`                                    | 普通 API Key，按量计费（2026-11-01 起收费） |
| `minimax-token-plan` | `chat-provider` | 否         | `POST https://api.minimaxi.com/v1/coding_plan/search`（国际 `api.minimax.io`）     | Token Plan `sk-cp-` Key，含在套餐额度       |
| `bigmodel-api`       | `chat-provider` | 否         | MCP `https://open.bigmodel.cn/api/mcp/web_search_prime/mcp`，工具 `webSearchPrime` | Coding Plan Key，套餐 MCP 额度              |
| `zai-api`            | `chat-provider` | 否         | MCP `https://api.z.ai/api/mcp/web_search_prime/mcp`，工具 `webSearchPrime`         | Coding Plan Key，套餐 MCP 额度              |
| `jina`               | `independent`   | 是         | `POST https://s.jina.ai/{encodeURIComponent(query)}`，`respondWith: "no-content"`  | Jina API Key，按量计费                      |

## 产品规则

- 搜索源自动识别：个人 provider 的 `templateId ∈ WEB_SEARCH_CAPABLE_PROVIDER_TEMPLATE_IDS` 即为候选；`templateId` 缺失时按 `api.baseUrl` 签名回退匹配。识别逻辑 UI 与 CLI 共用同一个 shared 常量，不允许第二份名单。
- MiniMax（按量）、BigModel API、Z.ai API 等标准模板不是搜索源：其 Key 调不通上述端点，不进入候选。
- `jina` 是内置「独立搜索源」模板：search-only，无任何聊天模型（模板不带 `builtinModelIds`），不进登录引导（quota 模板白名单不含）与模型选择器；实例只能从「网络搜索」页添加。
- 来源类型由 shared 模板元数据（`WEB_SEARCH_PROVIDER_ENDPOINTS` 的 `source`）声明，不另建模板名单，也不在 UI 内联 `templateId === "jina"` 之类的分支。`independent` 与「可手动添加」是同一判据，不再维护 `manuallyAddable` 副本；新增允许的独立搜索源时只更新该元数据与 `zcode-builtin.json` 模板，UI 目录与配置弹窗自动生效。
- 「网络搜索」页提供通用「添加搜索源」入口。添加目录 = `providerTemplates` 中 `source` 为 `independent` 且 access 类型为 Key 型（`api-key` / `zhipu-coding-plan-api-key`）的模板（名称、Key 管理链接、access 类型均来自模板元数据）；当前目录只有 `jina`。四个 `chat-provider` 搜索源只自动识别，不出现在该目录，也不能从该页新增。目录为空或仍在加载时添加入口禁用。
- 点击「添加搜索源」只打开表单，不写盘。表单选择受允许模板并填写该模板的 API Key（创建时必填）与出站代理；显式提交后才创建一个新的个人 provider 实例（`templateId` 为所选模板、`standard-personal` 组），实例名按模板名自动去重（Jina、Jina-2…），**允许重复添加**。不存在“按钮点击即持久化空实例”的路径。
- 独立搜索源实例（按 `source === "independent"` 判定）的行设置按钮打开同一套通用弹窗，可编辑 Key、出站代理并删除实例。Key 为空时保存表示显式清除（行内警示、激活时跳过），不新增第二份 Key 存储。总开关关闭只停止 WebSearch 工具暴露，不阻止本页继续配置或删除已有实例。
- 出站代理模式为 `default`（跟随网络设置）/ `proxy`（强制走网络分区代理）/ `direct`（强制直连），语义与 per-provider `proxyMode` 一致，唯一事实在 provider rule，不新增第二份代理配置。
- 独立搜索源模板不得出现在模型供应商添加目录：该目录按同一份 `source === "independent"` 元数据过滤，避免把 search-only 模板当聊天供应商添加。
- 已有 `templateId: "jina"` 的个人 provider 继续按原 provider id、Key、`proxyMode` 与 `webSearchProviderOrder` 被识别和使用，不做 id/名称迁移；旧的无 Key Jina 实例仍显示警示并可在此弹窗补 Key。
- 独立搜索源实例与聊天附带搜索源共用排序、激活与快照语义；Key 非空才可被激活，计费归属由模板元数据 `billing` 决定。
- 搜索源解析不得依赖聊天模型 Registry：零模型独立源（当前 `jina`）不会进入 `registryProviders`，CLI 必须从 `ProviderRegistryService` 的解析快照 `resolution.resolvedProviders` 读取，只筛 `enabled`、`providerIssues` 为空、模板命中与非空 Key；模型数量不参与搜索源判定。Key 的 access 判定复用 `packages/provider` 公开的 `isApiKeyAccess`（同时接受 `api-key` 与 Z.ai/BigModel Coding Plan 的 `zhipu-coding-plan-api-key`），不得只认 `api-key`。
- 设置页展示候选列表，支持拖拽与上下移动排序；新出现的候选追加尾部；**排第一的激活使用**。
- 排序交互（拖拽松手与上/下箭头）共用同一份 UI 即时呈现：操作完成后立刻按新顺序渲染，不等 `setting.json` 写入与回读返回；「激活」徽标跟随当前渲染的第一项。取消拖拽（Esc / 指针取消）不提交、不改变顺序。
- UI 的 pending 顺序只有一个所有者：`packages/ui/src/settings/useOptimisticReorder.ts`。设置页不得再维护第二份临时顺序或第二条持久化路径；权威顺序始终是保存并回读后的 `AppSettings.webSearchProviderOrder`，pending 只做渲染投影。
- 连续排序按最新 pending 立即渲染，持久化写入串行（前一笔完成后再写下一笔），迟到结果不能覆盖更晚的 pending；失败按 operationId 失效，只有仍是最新 pending 的那笔失败才回到权威顺序，迟到失败不得清除更晚的 pending；最终顺序以最后一次成功写入的权威回读为准。
- 排序卡片允许正在拖动的行越过卡片顶部而不被裁切；仅该候选列表卡片取消裁切，其它设置卡片保持现有裁切。拖动中的行使用卡片背景与阴影，避免透出下层内容；非拖动状态不变。
- `AppSettings.webSearchProviderOrder` 未初始化（字段缺省）时按固定优先级派生默认序：Z.ai Coding Plan → BigModel Coding Plan → MiniMax Token Plan → DeepSeek（套餐内优先、按量靠后）。派生结果在用户首次修改排序时才落盘；派生函数只有一份，UI 展示与 CLI 执行共用。
- `AppSettings.webSearchEnabled` 总开关缺省 `true`；开关关闭、候选为空、或激活项无法解析（provider 已删除 / 无 apiKey）时，WebSearch 工具不暴露。
- 策略（开关+排序）在会话 app 创建/恢复边界一次性快照绑定进 `WebSearchPort`；设置切换只影响之后创建/恢复的会话，已活跃会话的工具面与激活搜索源不随开关实时翻转（与 dynamic-workflow / off-peak 策略同构：只影响之后创建/恢复的 record）。正在执行的调用不中断。
- 该会话的 `WebSearchPort` 必须从 `ZCodeAppOptions` 传入主 `AgentRuntime` 与工具执行器。子代理、传统工作流子会话和脚本工作流 actor 继承父会话的同一端口，不重新读取全局策略或单独取快照；工具声明与执行共用这个端口。是否允许使用仍由各自已有的工具白名单、禁用表和权限规则决定，不因继承端口扩大工具范围。记忆提取代理仍由既有执行策略拒绝网络工具，不为其新增搜索能力。
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
      ├→ ZCodeAppOptions.webSearchPort → 主 AgentRuntime → 主工具执行器
      └→ 子代理 / 传统工作流子会话 / 脚本工作流 actor → 各自工具执行器（借用同一端口）
  → 各 runtime 按已有工具权限声明 WebSearch → 模型调用 → core executor → handler
  → 读快照偏好（开关+顺序）→ ProviderRegistryService 解析快照（resolvedProviders，含零模型独立源）解析端点/Key
  → 按 templateId 分发 REST / MCP 适配器 → 供应商搜索 API → 归一化 WebSearchOutput
  → 其它窗口经 appRuntimePreferencesChanged 广播只读重渲染，不再二次写盘（防回环沿用既有链路）
```

1. 排序/开关的唯一事实源是 `setting.json`；provider 实例与 Key 的唯一事实源是 `provider_config.json`（本任务不改其结构）。
2. CLI 偏好缓存只在收到推送时更新；会话 app 创建/恢复时把策略快照绑定进 WebSearchPort，WebSearch 执行读会话快照，无轮询、无定时器。主运行时和派生运行时只借用端口，不持有第二份可写策略，也不负责释放进程级执行器。Desktop 连续链路与手机 Web 恢复链路仍复用同一 Host 会话；恢复时走原有会话装配边界，不新增 Agent 或偏好写入路径。
3. 激活项解析失败（provider 删除、无 Key）按"不暴露工具"处理，不抛运行时错误。
4. 旧 CLI（不认识 `workspace/updateWebSearchPolicy`）由 host 按 method-not-found 降级忽略；旧 host 未推送时 CLI 缺省为"无搜索源"，即不暴露 WebSearch。

### 设置页排序的 UI 投影（不改变持久化链路）

```text
设置回读 webSearchProviderOrder ∪ 本机候选（resolveWebSearchProviderOrder）
  → authoritativeIds（权威顺序，唯一事实源）
  → useOptimisticReorder({ authoritativeIds, persist })
       ├ pendingIds（唯一 UI pending owner，串行写入）
       └ 最新 pending 失败 / 权威已同序 / 候选成员变化 → 清 pending
  → renderedIds = pending ?? authoritative
  → 候选对象投影 → <ul> 行顺序 + 激活徽标 + 箭头 disabled
  → 拖拽松手 / 箭头点击 → commit(arrayMove(renderedIds, …))
  → useSettings().update({ webSearchProviderOrder })（既有写入/回读/广播链路）
```

- pending 只在成员集合与权威顺序一致时生效；provider 增删导致成员变化时回退权威顺序，避免把已删除的 provider 继续展示。
- 拖拽落点索引与箭头移动都基于当前 `renderedIds`，因此连续操作在写入未返回时仍能正确累积。
- 不新增定时器、假延迟或 `flushSync`；即时呈现只来自 pending 投影。

### 独立搜索源实例的添加 / 编辑 / 删除

```text
用户打开「添加搜索源」→ 表单 draft（模板 + Key + 代理，纯 UI 状态，不落盘）
  → 显式提交（API Key 非空）→ createPersonalProvider({ templateId, initialConfig.access })
  → provider_config.json 事务写入 → Settings View 权威回读（候选自动出现）
  → 仅当代理不是 default：saveProvider({ ...createdProvider, proxyModeUpdate }) 串行跟进同一实例
  → resolveWebSearchProviderOrder 将新实例追加尾部（或按派生序）→ 既有排序链路
```

1. provider 实例与 Key 的唯一事实源是 `provider_config.json`；表单 draft、模板选择与错误提示都是 UI 局部状态，不是已接受配置。排序/开关仍以 `setting.json` 为唯一事实源。
2. 创建时先写入 `templateId` 与 Key，再写非默认代理；两步都只作用于同一个新 provider id。创建成功而代理写入失败时，实例保留已写入的 Key 与默认代理，弹窗切换为该实例的编辑态并保留用户已提交的代理选择，重试只更新代理，不会再次创建实例。
3. 提交期间禁用提交、取消与关闭，重复点击不产生第二个实例；取消/关闭弹窗不写盘。编辑保存空 Key 表示显式清除；删除失败保留实例与弹窗现场，不无提示地关闭。
4. 删除后排序中的残留 id 由既有 `resolveWebSearchProviderOrder` 剔除，激活项自动顺延；不新增清理写路径。
5. 桌面与手机 Web 共用同一设置服务与 Host 会话事实；不新增 Agent、Host 或本地缓存路径。
6. 弹窗草稿只在「打开会话 / 切换到另一个实例」时从权威状态重置；创建态显式切换模板时只清空上一个模板的 Key 与代理，所选模板保持不变，不得被重置弹回目录首项。provider 列表刷新产生的新对象引用不得覆盖已输入的 Key 与代理。编辑中的实例被其它窗口删除后，弹窗自动关闭（保存中除外），失效实例的保存/删除保持禁用。
7. 总开关只控制 WebSearch 工具是否暴露；已存在的独立搜索源仍可在本页配置与删除，只有排序（拖拽与上下移动）在关闭时禁用。
8. 「添加搜索源」目录只接受 Key 型 access 的独立模板；目录为空或模板仍在加载时添加入口禁用，不打开无模板可提交的空表单。当前不支持账号型 access，不为此预置抽象。

## 接口与实现边界

- `packages/shared/src/provider-search-capability.ts`：`WEB_SEARCH_CAPABLE_PROVIDER_TEMPLATE_IDS` 与模板 → 搜索端点描述（kind: `rest` | `mcp`、endpoint、toolName、`source: "chat-provider" | "independent"`、计费归属）的唯一映射；UI 与 CLI 共用。`source: "independent"` 即「本页可手动添加」，由唯一判定 `isIndependentWebSearchTemplateId` 表达，不再维护 `manuallyAddable` 副本；不新增第二份模板名单。
- `packages/shared/src/validationAppSettings.ts`：`webSearchEnabled`（默认 `true`）与 `webSearchProviderOrder`（`string[]`，缺省未初始化）进入 full schema 与 patch schema。
- `packages/shared/src/app-runtime-preferences.ts`：广播 payload 增加两字段，`.strict()` 校验同步更新。
- `packages/shared/src/zcode-protocol/index.ts`：新增 `workspace/updateWebSearchPolicy` 方法与 params/result strict schema；归入 `zcodeProtocolMethods`。
- `packages/services/src/zcode-agent/zcodeAgent.ts` 与 `zcodeAgentService.ts`：`ZCodeAgentAppRuntimePreferences` 增字段；`syncAppRuntimePreferences` 增加推送；旧 CLI method-not-found 降级忽略。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/web-search-policy.ts`：新协议 handler（`parseParams` → `context.appRuntimePreferences`）；`server.ts` dispatch、`server-types.ts` 缺省值。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/web-search-port.ts`：`createPolicyWebSearchPort` 把偏好视图装配成 `WebSearchPort`；`createSessionPolicyWebSearchPort` 在 app 创建/恢复边界对策略（开关+排序）做快照绑定，会话生命周期内不再读实时 context。
- `apps/zcode-cli/packages/contracts`：`WebSearchPort` 端口类型（`resolveActiveProvider(): ActiveWebSearchProvider | undefined` + `search(input, provider, { abortSignal }) → WebSearchOutput`），复用现有 `WebSearchInputSchema/OutputSchema`；`ActiveWebSearchProvider` 携带端点描述与该 provider 实例的 `proxyMode`。
- `apps/zcode-cli/packages/adapters/src/web-search/`：`common.ts`（fetchJson / 60s 超时 / 域名过滤与去重 / 输出归一化）、`deepseek-rest.ts`、`minimax-rest.ts`、`jina-rest.ts`（`POST {endpoint}{encodeURIComponent(query)}`，body `respondWith: "no-content"` 只取摘要不抓正文，映射 `data[]` 的 `title/url/description`）、`zhipu-mcp-search.ts`（StreamableHTTP + Bearer，按 endpoint|apiKey|proxyMode 池化）、`executor.ts`（`createRegistryWebSearchExecutor`：从 `ProviderRegistryService.getSnapshot().resolution.resolvedProviders` 按偏好解析激活源，只筛启用/配置完整/模板命中/Key，不读模型 Registry、不按模型数量过滤；并按 `proxyMode` 缓存 proxy-aware fetch）。零模型独立源不会进入 `registryProviders`，因此不得改回 `getView()`/`getProvider()` 取搜索源。错误分类为可恢复工具失败并透传供应商信息。
- `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`：把 `options.webSearchPort` 传入主 `AgentRuntime`；`workflow-facade.ts` 与 `script-workflow-child-runtime.ts` 从同一 `appOptions.webSearchPort` 传入子运行时，不另建端口。
- `apps/zcode-cli/packages/core`：`config.ts` 的 `getTools`/`shouldExposeWebSearch` 按"开关 + 激活搜索源可解析"门控（与 model 无关）；`methods/subagent.ts` 把父端口传入子运行时；`handlers/websearch.ts` 只经注入的 `WebSearchPort` 调用执行器；`websearch-results.ts` 不再识别 Anthropic 形状。记忆提取继续在 `memory-agent-loop.ts` 按既有网络隔离策略拒绝搜索。
- `packages/ui`：`settingsNavigation.ts` 新增 `webSearch` 分区 id（basics 组已有 `network`，不得撞名）；`settingsPageConfig.ts` 在 agentCapabilities 组注册；`SettingsPage.tsx` 增渲染分支；新组件 `settings/WebSearchSettingsSection.tsx` 用 dnd-kit 可排序行实现拖拽 + 上/下按钮排序，排序经 `resolveWebSearchProviderOrder` 合并后提交 `update({ webSearchProviderOrder })`；即时顺序复用 `settings/useOptimisticReorder.ts`（拖拽与箭头同一 commit 路径，页面不另存 pending），候选投影抽为纯函数便于回归测试；候选列表卡片通过 `SettingsGroupCard` 的可选 `className` 单独关闭裁切，其它卡片不变。独立搜索源目录逻辑抽到 `settings/webSearchSourceCatalog.ts`（模板元数据 → 可添加项、草稿校验；目录与行设置入口共用同一判据），添加/编辑/删除共用 `settings/WebSearchSourceDialog.tsx`，行设置按钮仅在实例出现在目录时渲染；实例创建/保存/删除只经 `useModelProviders` 暴露的既有 `createPersonalProvider` / `saveProvider` / `deleteProvider`，不新增写入路径。`settings/model-provider-section/ProviderTemplatePicker.tsx` 用 `isIndependentWebSearchTemplateId` 过滤聊天供应商添加目录；i18n 双语 `settings.webSearch.*` 使用通用键，不出现模板专属键。
- `config/provider/zcode-builtin.json`：`templateRules` 新增 `jina` 模板（`access.type: "api-key"` + `apiKeyManagementUrl`、`api.baseUrl: "https://s.jina.ai"`、builtin logo `jina`，缺资源时 UI 回退通用图标；不带 `builtinModelIds`）；该模板不含 `supportsNativeWebSearch` 等模型能力字段。
- 旧路径清理范围：`tool-transform.ts`、`runner-options.ts`、`model-execution.ts` 相关分支；`supportsNativeWebSearch` 从 `packages/shared/src/model-config.ts`、`packages/provider`（resolver、manual-model-config）、`config/provider/zcode-builtin.json`（5 条规则）、UI ProviderModelMetadata/Dialog/DraftState、双语 i18n 与相关测试中移除。

## 验收场景

1. 添加 DeepSeek 供应商（配置 Key）后，「网络搜索」页自动出现该候选且排第一（唯一候选时）；会话内 WebSearch 调用 `POST /v1/tools/search` 并返回归一化结果。
2. 添加四家中的多家时按固定优先级派生默认序；拖拽/上下移动后第一名变化，之后创建/恢复的会话使用新激活项，已活跃会话保持创建时的激活项。
3. 总开关关闭后，之后创建/恢复的会话不再暴露 WebSearch 工具；已活跃会话的工具面保持创建时状态，重新打开会话后生效。设置页仍可配置或删除已有搜索源，只有排序被禁用。
4. 未添加任何搜索源供应商时页面展示空态引导；WebSearch 不暴露（含 Anthropic 模型）。
5. 激活项 Key 被清空或 provider 删除后，WebSearch 不暴露；页面行内出现警示。
6. MiniMax（按量）模板的 provider 不出现在候选中；MiniMax Token Plan 出现并标注需 Token Plan Key。
7. 旧 CLI 连接新 host：host 推送被降级忽略，不报错；旧 setting.json 无新字段时按缺省解释（开关开、顺序未初始化）。
8. 点击「添加搜索源」只打开表单，不产生 provider 实例；取消/关闭后不写盘。表单目录只列 `source` 为 `independent` 且 access 为 Key 型的模板（当前为 Jina），目录为空或加载中时入口禁用；Key 为空时提交禁用；选择模板、填写 Key（可加代理）并提交后创建一个新实例并进入候选列表，Key/代理互相独立；重复添加得到 Jina、Jina-2 等多实例。
9. 独立搜索源实例在通用弹窗保存 Key 并排序到第一后，之后创建/恢复的会话激活该实例：WebSearch 调用对应模板端点（当前 `POST https://s.jina.ai/{query}`）并返回归一化结果；删除实例后从候选移除，排序中残留 id 被剔除，激活项顺延。已有 Jina 实例的 provider id、Key、代理与排序不迁移、不丢失。
   9a. 真实 `ProviderConfigResolver` + `ProviderRegistryService` 装配回归：零模型 Jina 实例出现在 `resolution.resolvedProviders` 但不在 `registryProviders`，执行器仍能激活并调用端点；`disabled`、无 Key、模板缺失导致 `providerIssues` 非空的实例均不激活；可用聊天源仍进入模型 Registry、可被激活，排序/快照语义不变。
   9b. Access 兼容回归：真实 resolver/service 下，Z.ai 与 BigModel 的 Coding Plan 实例使用 `zhipu-coding-plan-api-key` access 时仍被识别为搜索源并激活；DeepSeek、MiniMax Token Plan 的 `api-key` 实例与零模型 Jina 均不退化。执行器不得用 `access.type === "api-key"` 自建判定，必须复用 provider 公开的 `isApiKeyAccess`。
10. 独立搜索源模板（当前 jina）不出现在模型供应商添加目录、登录引导与模型选择器；供应商设置页可见实例本身（可改名/删除）。四个聊天附带搜索源不出现在「添加搜索源」目录。
    10a. 共享元数据回归：四个聊天模板的 `source` 为 `chat-provider`，jina 为 `independent`；UI 目录、行设置入口与添加表单只由该元数据（加模板 Key 型 access 约束）驱动，源码中不得出现按 `"jina"` 分支或内联模板名单。非 Key 型 access 的模板不进入目录，也不提供本页设置入口。
    10b. 隔离 Chromium 交互回归：添加入口只打开弹窗，取消不写盘；单模板目录只展示 Jina 且不渲染单选控件；四个聊天搜索源无设置入口；Key 为空时添加禁用；提交只创建一个实例并携带 `initialConfig`；提交期间重复点击、Escape 与关闭均无效；创建成功而代理写入失败时转编辑态，保留 Key 与已提交的代理选择，重试只更新代理不重复创建；已有实例可清空 Key、改代理，删除确认取消不删除；provider 列表以新对象刷新后草稿不丢；编辑实例被远端删除后弹窗自动关闭；总开关关闭时设置入口仍可编辑、保存与删除，排序控件禁用；目录为空或加载中时添加入口禁用。
    10c. 多独立模板的弹窗回归：直接向 `WebSearchSourceDialog` 传入两个模板（只构造 props，不扩大生产目录）时，切换到第二个模板后所选模板保持不回退，Key 与代理随切换显式清空；提交携带第二个模板；关闭重开回到目录首项并清空草稿。生产目录与四家隔离仍由 `source` 元数据决定，不因该用例改变。
11. 通过真实 `createZCodeApp` 装配主会话，搜索开启且有可用源时，`runtime.getTools()` 和模型请求的工具列表包含 `WebSearch`；实际工具调用到达同一个注入端口并返回结果。开关关闭、无可用源或端口缺席时仍不暴露。不能只用假端口单测门控函数替代此装配回归。
12. 子代理（包括 Explore）、传统工作流子会话和脚本工作流 actor，在已有工具范围允许 `WebSearch` 时能够用父端口搜索；显式不包含或禁用该工具时不向模型声明。父会话创建后翻转全局策略，再派生的子运行时仍沿用父快照。记忆提取代理调用 `WebSearch` 时仍在工具执行前被既有网络隔离策略拒绝，搜索端口不会被调用。
13. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 与新增单测（adapters/core/bootstrap/shared）全部执行并报告真实结果。
14. 设置页把末项拖到首位（或连点「上移」）后，松手即看到新顺序且「激活」徽标位于新首项；在 `setting.json` 写入与回读完成前不出现回跳或延迟跳位。写入悬而未决时继续排序，列表按最新 pending 更新，落盘按操作顺序串行；最终回读顺序等于最后一次操作。
15. 当前最新 pending 写入失败时列表回到权威顺序并记录错误（renderer logger）；更早的迟到失败只失效它自己，不得清除最新 pending。拖拽取消（Esc / 指针取消）不写盘、不改顺序；候选增删导致成员变化时旧 pending 失效并回到权威顺序。
16. 将首项向上拖过卡片顶部时该行保持可见、不被卡片裁切；关闭总开关后拖拽手柄与上下箭头禁用；键盘（空格抓起 / 方向键移动 / 空格放下）与窄屏触屏拖拽仍可用。
17. 交互场景若没有不依赖运行中 YCode 的独立浏览器测试环境，则在测试计划中列出并明确未执行；不得用 CDP/DevTools/UI 自动化操作正在运行的 YCode。

## 负面边界

- 不做自定义搜索源接入（只按内置模板实例化，不开放任意端点/任意模板/手动填写端点）；「添加搜索源」目录只展示 `source === "independent"` 且为 Key 型 access 的受允许独立模板，当前仅 jina；不接 DeepSeek `/v1/tools/fetch`；WebFetch 行为不变。
- 不做搜索配额、并发、重试策略管理与用量统计面板改动。
- 不修改 provider_config.json 结构与供应商设置流程；不新增持久化文件。
- 不改变 WebSearch 权限、审批、结果预算与工具卡文案；不动 subagent 工具清单结构。
- 不在 UI 直接调用搜索端点（执行只发生在 CLI 运行时）。
