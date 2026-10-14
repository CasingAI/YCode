# Spec: CLI Proxy 二进制插件与「CLI Proxy API」供应商分类

## 目标

新增**二进制插件**这一类插件：它的主体是一个独立二进制（CLI Proxy），不属于我方进程树内的内嵌插件；它把一个本机 CLI/Agent（首批为 Codex）的能力通过本机 HTTP 服务暴露成 OpenAI 兼容 API，让用户在「模型与供应商」里像用普通供应商一样使用 Codex 的模型。

二进制插件是**内置、默认启用、不可关闭、不可卸载**的插件类别（是否拉起二进制只由依赖 provider 派生按需启动，见「按需启停」），但二进制本身**没有界面**：它的可见形态是「设置 → 插件」页新增的**第四个签「外部插件」**——签内列二进制插件条目，条目详情提供版本管理（见「插件页可见性与版本管理」）；另一个接入点是「模型与供应商」的 CLI Proxy API 分类（Codex provider 配置），外加既有的更新提示。

更新与分发方式借鉴仓库既有的外部二进制设施（`packages/zcode-server-cli/src/runtime/`）与官方 CDN 插件范式（`apps/zcode-cli/packages/adapters/src/plugins/official-marketplace.ts:6,67`）：启动时自动追新（发现内置版本落后则下载最新版，征得用户同意后切为 active），本地多版本共存，另有编译期内置兜底版本。

## 非目标

- 不为二进制插件引入新的组件 kind（`PluginComponentType`）、不改协议组件枚举、不改插件详情徽标。二进制插件不复用 `enumeratePluginComponents` 的组件分组展示。
- 不引入需要通过商店「购买/安装」流程获取的二进制插件：首批是**内置**插件，作为「设置 → 插件」页第四个签「外部插件」的条目出现（见「插件页可见性与版本管理」），不进入商店的购买流程。
- 不改现有三个签（插件/MCP/技能）的语义与内容；第四个签只新增一个插件级过滤视图，不复用也不改动那三个签的选择器。
- 不覆盖除 Codex 外的 CLI/Agent；Claude/Gemini 等后续单开 spec。
- 不做二进制插件自身的 UI 面板、状态页、日志页。
- 不改 `mobile-remote-control` 的局域网远控：那是把 YCode 自身服务暴露给浏览器，与本 spec 的服务方向不同（见「安全边界」）。
- 不做额度主动刷新/定时轮询（见「额度：只被动观测」）。
- 不改模型 id，不向模型注入自我身份（见「模型名与展示」）。

明确一句：**二进制插件是「设置 → 插件」页正规呈现的一个内置类别**，落在第四个签「外部插件」里，条目详情带版本管理区块。「不新增组件 kind」只约束能力扩展点，**不约束插件页可见性**——签的可见性靠插件级过滤实现，与插件有没有组件无关（见「为什么不用组件 kind」）。

## 产品规则

### 插件类别与内置身份

- 「二进制插件」是与内嵌插件并列的插件类别：它仍出现在插件体系里，遵循 enable/disable、内置（Builtin）与可恢复内置（Restorable Builtin）语义（`CONTEXT.md:13,75`）。区别在于它的可执行主体是外部二进制，而不是靠 `plugin.json` 的 commands/agents/skills/hooks/mcpServers 参与运行时。
- 首批唯一的二进制插件是 **CLI Proxy**，绑定一个 GitHub 仓库作为发布源。它默认内置、默认可用；用户无需"安装"即可在添加了依赖它的供应商后使用。
- 二进制插件**不需要**在 `plugin.json` 声明内嵌组件；它的 manifest 只声明自身为二进制插件、发布源与可达的兜底版本（形态见「接口」）。

### 版本：多版本共存、默认最新、内置兜底、启动时自动追新（已定）

- 本地**多版本共存**：每个版本落在专属目录（含版本号），**不覆盖、不删除**。目录布局沿用 `packages/zcode-server-cli/src/runtime/releaseInstaller.ts:80` 的 `<version>-<target>-<archiveSha12>` 思路，但根目录改到二进制插件专属目录（见「状态所有者」）。
- 用户可**像选模型一样选版本**：设置里能看到已下载版本清单并切换 active 版本，**默认使用最新**已下载/可用版本。
- **编译期内置兜底版本**：随应用打包一份（可能较旧）二进制，用户从未联网下载过任何版本时也能直接用。
- **内置分发（2026-10 落地）**：构建期从上游 release 下载目标平台/架构的
  CLIProxyAPI 可执行文件（版本 8.0.27，真机验证过），经 sha256 校验后落到
  构建缓存 `packages/desktop/bundled-tools/<platform>-<arch>/cli-proxy/`（git 忽略，
  二进制不进仓库），electron-builder 以 extraResources 打进 `resources/tools/cli-proxy`。
  macOS 打包前做 ad-hoc 签名（`codesign -s -`）并保证可执行位。
  缓存命中也必须读 `VERSION` 标记与钉死版本比对（缺失/不符即重下），下载失败或校验
  失败直接抛错中断构建；electron-builder 在 afterPack 对 `tools/cli-proxy` 做存在性
  断言（仿 node-pty 惯例），缺资产绝不静默出包。构建期/打包期/运行时统一走
  `resolvePlatformKeyForPackagedApp()`（= `getTargetPlatform().key`，支持
  `ZCODE_TARGET_OS/ZCODE_TARGET_ARCH` 覆盖）同一口径。
  下载走 curl（Node fetch 不认代理环境变量；无 curl 的平台回退直连 fetch，
  直连被拒则如实失败中断构建）。macOS `signIgnore` 已收窄到
  `tools/cli-proxy` 子目录，ripgrep 等其他工具资产仍走正常签名链路。
  打包现状（2026-10-14）：extraResources 已把 cli-proxy 落盘到
  `.app/Contents/Resources/tools/cli-proxy/`（arm64/ad-hoc/`--help` 可执行均验证），
  但 afterPack 的 app.asar 重写步骤失败导致 bundle 未完成，见下。
- **运行时路径解析**：Host 经 `resolveBundledCliProxyDir()` 解析——打包态走
  `process.resourcesPath/tools/cli-proxy`，开发态走仓库内
  `packages/desktop/bundled-tools/<key>/cli-proxy`（不存在则优雅降级为无内置，
  不崩溃）。解析结果注入 `createCliProxyService({ bundledDir })`。
- **优先级**：用户已下载并选中的版本 > 内置兜底；内置存在时启动不发任何网络请求。
  首启自动下载仅在“需要启动且无任何可用二进制（含内置缺失）”时作为最后兜底，
  不再是默认路径。启动期网络请求为 0（每日检查与用户手动检查除外）。
- **登录链路**：授权 URL 返回后由额度区的 `useEffect` 经 `IPlatformService.openExternal`
  自动打开系统浏览器（桌面走 preload→main→`shell.openExternal`，URL 限 http/https）；
  手动“打开浏览器授权”按钮兜底。取授权 URL 时**必须带 `is_webui=true`**
  （`cliProxyAccount.ts:getCliProxyCodexAuthUrl`）：代理只在此时才为本次登录起 1455 回调
  转发器（源码 `internal/api/handlers/management/auth_files_provider_oauth.go` 的
  `isWebUIRequest` → `startCallbackForwarder(codexCallbackPort)`），把
  `http://localhost:1455/auth/callback?code&state` 302 到 `127.0.0.1:<server.port>/codex/callback`
  由代理自己完成换码落盘。不带该参数时没有任何进程监听 1455，浏览器回跳被拒、
  OpenAI 侧报 `invalid_auth_step`（真机复现 2026-10-14），这是本次登录失败的根因。
  代理未 running 时 `getCodexAuthUrl` 先按需拉起，拉起失败则登录进入失败态并给出文案。
  1455 被占时转发器实测仍返回 200（它绑 `0.0.0.0:1455`），降级提示留在轮询超时后给出。
  回调接受（200 ok）不等于换码完成，必须继续轮询 `oauth/status` 到 ok/error。
  Web/远端无服务，保持禁用并提示去桌面端。
- **额度区文案分工**：灰字 startingHint 承担“代理尚未启动”说明；橙色失败框只在真正
  可操作的失败时出现，不复述灰字内容（proxy-stopped 走独立的“代理未启动”登录文案）。
- **登录入口可见性（2026-10-14 真机复测修正）**：入口**不得由额度错误码决定**。
  旧实现要求 `quota.error` 属于 `not-logged-in`/`proxy-stopped` 或 `quota` 为 null 才渲染入口；
  当本机 `~/.cli-proxy-api` 已有凭据（例如用户此前手工跑过 CLIProxyAPI）而尚无额度观测时，
  服务返回 `no-observation`，入口随即消失，用户既看不到额度也无法重新登录——死路。
  现规则：桌面端（`cliProxyAccount` 判定服务可用）**始终渲染登录入口**；
  - 未登录（凭据缺失 → `not-logged-in`，或代理未启动 → `proxy-stopped`）：文案为引导 + 「登录 Codex 账号」；
  - 已登录但无观测（`no-observation`，或已拿到窗口）：文案改为「重新登录 / 切换账号」，
    按钮与流程相同，不隐藏入口。
  web/远端（服务不可用）仍不渲染入口，只显示桌面端提示；失败态与手动兜底按钮不变。
- **额度快照随运行态刷新（2026-10-14 真机复测修正）**：额度与登录可用性都由代理运行态决定。
  旧实现只在挂载与页面可见时取一次快照，添加 provider 触发按需启动后不再重取，
  真机上出现"代理已在 `127.0.0.1:8317` 监听、额度区仍显示代理正在启动"的陈旧态。
  现规则：`useCliProxyAccount` 订阅 `ICliProxyService.onDidChangeStatus`，状态或端口变化
  即重取一次快照（同值不重复请求）。这不是轮询——只在运行态变更时被动重取。
- **dev 链路的内置配置来源（2026-10-14 真机复测修正）**：从 YCode 应用内打开的终端会
  继承 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`，指向正在运行的那个应用版本的运行时缓存
  （例如 4.0.140 的 endpoint 缓存）。`scripts/dev-desktop-env.mjs` 在 dev 链路显式删除该
  变量，使本地构建/运行使用仓库内 `config/provider/zcode-builtin.json`；打包链路
  （bundle/CI）行为不变。否则旧版本缓存过不了当前 schema，`dev:desktop` 会停在
  `build:desktop-agent` 的 `decodeZCodeBuiltinRelease`。
- **内置远端配置刷新失败只降级（2026-10-14 真机复现）**：CDN 配置过不了当前 schema 时
  （`ZCode Built-in cdn: invalid schema at providerRules.0.config.group`），
  `provider-settings.refresh` 旧实现把该错误原样抛给 UI，导致供应商设置页整体卡在
  加载中、CLI Proxy 的依赖判定拿不到 view、代理永不按需启动。现规则：内置远端刷新失败
  只记日志并沿用当前生效配置（runtime 本就回落内置），refresh 仍返回快照；
  账号源刷新失败保持原抛错语义（权益是执行事实，不静默降级）。
- **兜底现状（2026-10 真机复测确认）**：桌面构建实际未打包 cli-proxy 二进制
  （`stage-official-plugins.mjs:123-132` 与 `sea-official-plugin-assets.mjs:95-104`
  对 cli-proxy 只收 manifest、`requiresRuntime: false`；electron-builder 无相关资产；
  Host 构造服务时也不传 `bundledDir`（`host/index.ts:1900-1945`）。
  因此 `resolveActiveBinaryDir` 的 bundled 兜底分支实际走不到，新机器首启无二进制。
- **首启二进制来源（唯一路径）**：用户添加 Codex provider 后 `refresh()` 需要启动、
  但无可用二进制时，`doStart` 主动跑一次更新检查（自动下载最新版并登记为 active，
  见「启动时自动追新」），再重试启动；仍无二进制才如实报 `binary-missing`。
  该下载只在"需要启动且无二进制"时触发一次，不做定时重试、不掩盖失败。
- **启动时自动追新（已定）**：启动时发现内置版本落后则下载最新版，征得用户同意后切为 active。不静默切换。
- 版本切换只改 active 指针，不删除旧目录（与 `releaseManager.ts` 单一 `current.json` 指针的差异：这里需要**多版本保留 + 用户可选**，属本 spec 新增能力，仓库现有代码无先例）。

### 插件页可见性与版本管理

- **独立第四签「外部插件」（已定）**。它实现为**插件级过滤**：列**二进制插件条目本身**（过滤条件 `binaryPlugin != null`），复用既有的 `PluginList`/`PluginStoreCard`（`PluginsSection.tsx:1286`、`PluginStoreCard.tsx:292`），不列组件条目、不按组件 kind 过滤。
- 现有签的准确构成（已确认）：顶层只有 **3 个签** —— `plugins` / `mcps` / `skills`（`PluginsSection.tsx:1188-1223` 的 `TabsList`）；「命令」**不是签**，而是侧栏独立入口（`mode="command"` 经 `fixedTab` 进入，`:1015`；以静态标题渲染，`:1224-1243`；且 `normalizePluginTab("commands") → "plugins"`，`:103-105`）。默认签为 `plugins`（`:1012` `initialTab ?? (mode === "mcp" ? "mcp" : "plugins")`）。
  - `plugins` 签是**插件级**（列表项是插件，`:1276-1300`）。
  - `mcps`/`skills` 签是**条目级**（列表项是 MCP 服务器 / 技能条目，`:1302-1336`、`:1338-1364`）。
  - 第四签「外部插件」与 `plugins` 签同为**插件级**，仅过滤条件不同——这正是它不需要新组件 kind 的原因。
- 第四签的条目详情复用既有插件详情（`PluginStoreDetailView`），并在 `advanced` 插槽挂一个「版本管理」区块，承载：
  - **已下载版本列表**（含版本号与来源：远端下载 / 编译期内置兜底）；
  - **当前 active 版本**（默认最新已下载/可用版本）；
  - **有新版本提示**（联网检查到 GitHub 新 release 时出现，可忽略，不自动下载）；
  - **切换版本**按钮（切 active，旧版本目录保留不删）。
- 该区块挂在详情现有的 `advanced` 插槽（`PluginStoreDetailView.tsx:234`），与既有的 warnings / rootPath / hookDetails / `PluginConfigControls`（`PluginsSection.tsx:686-745`）同处——这是仓库既有的「插件带自定义设置区块」先例。
- 插件页列表与卡片都不以组件为存在条件：`pluginCapabilityProjection.ts:20 selectBuiltInPlugins`（`source === "official"` 且未安装）与 `:37 partitionPluginsForSettings`（仅排 `packageStatus !== "missing"`）都不按组件过滤，`PluginsSection.tsx:486 renderPluginRows` 逐条渲染，卡片 `PluginStoreCard.tsx:292` 只渲染头像/名称/描述/角标。因此**没有 commands/skills/hooks/mcp 的插件照样是一个列表条目**，其 `plugin.json` 可以是最小清单（仅 `name`/`version`）。
- 详情组件分区为空时本就不渲染（`PluginStoreDetailView.tsx:227` 对空 `orderedGroups` 无输出），因此二进制插件不会出现空白的"组件"区。
- **内置兜底版本的显示**：它是版本列表里的一行（标注为"内置/随应用打包"），用户从未下载任何版本时即为 active；一旦下载了更新的版本，默认最新覆盖它，但兜底版本行仍可见、可切回。

### 更新检查（已定）

- **启动时一次 + 每日一次**，走现有更新提示通道，不单独做角标。
- 有新版本只提示、不自动下载不自动切换；下载后的 active 切换需征得用户同意（见「版本」）。

### 按需启停

- CLI Proxy **随软件启停**：应用启动时若"存在依赖它的供应商"则拉起，退出时停止。
- **按需启动**：用户没有添加过依赖它的（Codex）供应商时**不启动**服务，也不占用端口。判定依据是「模型与供应商」里是否存在 `kind` 指向 CLI Proxy 的 provider 配置（见「事件顺序」）。
- 服务生命周期沿用 `mobile-remote-control` 的状态机范式（`docs/specs/mobile-remote-control.md:22-28`：`state` 运行时轴 + `enabled` 用户意图轴、Host 启动 `resumeIfEnabled`）。CLI Proxy 的"启用意图"不是用户开关，而是**派生自是否配置了依赖供应商**，这是与远控范式的关键差异。
- Host 接线顺序：provider 变更订阅先注册、再 `resumeIfEnabled()`、`resume` 后补一次
  `refresh()`。初始化窗口期内到达的变更不丢事件、不靠重试掩盖顺序问题。
- **无插件级启停开关**：二进制插件默认启用（播种 `defaultEnabled: true`），列表行与详情菜单**不渲染**启停开关与安装/卸载按钮（`shouldRenderPluginToggle`）；是否拉起二进制只看依赖 provider，与插件启用态无关。

## 状态所有者与接口

- **运行时状态唯一所有者**：Host 进程内的 `CliProxyService`（暂名），只在 Host 注册一次。持有二进制进程句柄、监听地址与端口、当前 active 版本、运行时状态轴（`stopped`/`starting`/`running`/`error`）。
- **持久化唯一所有者**：专属落盘文件（类比 `mobileRemoteControlStateStore.ts` 的独立文件做法，`docs/specs/mobile-remote-control.md:68`），内容至少 `{ version, activeVersionId, downloadedVersions[], releaseSource }`。**不与通用 `setting.json` 混存**：二进制路径与版本指针属于本机事实，不该跟着可导出/迁移的配置走。
- **令牌存储（已定，2026-10-14 修正数据面 api-key 的投影规则）**：管理面 key 与数据面
  api-key **独立落盘文件**（`management.key` / `data.key`），权限 0600，不进 `setting.json`。
  管理面 key 不进 provider 配置；**数据面 api-key 必须投影到依赖 provider 的
  `access.apiKey`**（见「端点投影」）：代理对 `/v1` 强制校验 `access.api-keys`（真机实测
  无/错 key 均 401），而 Registry 要求 provider 配置完整——`access.apiKey` 缺失时
  ProviderConfigResolver 判该 provider 不完整并**直接排除出模型选择器**（真机 + 脚本复现
  2026-10-14，这正是"Codex 卡片在设置页可见、模型却不出现在选择器"的根因）。
- **二进制专属目录**：默认根 **`~/.ycode/cli-proxy/`**（YCode 自有目录，2026-10-14 用户拍板与共享的 `.zcode` 数据目录解耦；可用 `ZCODE_CLI_PROXY_DATA_DIR` 覆盖，dev 链路经 `scripts/dev-desktop-env.mjs` 隔离到 `~/.ycode-dev-home/cli-proxy`），下分 `releases/<version>-<target>-<sha12>/`（多版本）、`current.json`（active 指针）；**下载缓存与解压**复用 `releaseDownload.ts:96` 与 `componentCache.ts:175`。
- **GitHub release 检查接口**：以 GitHub Releases API 为源（`GET /repos/{owner}/{repo}/releases`），把每个 release 的 assets 映射成内部 catalog 条目。内部条目 schema 可对齐 `packages/zcode-server-cli/src/contracts.ts:190` 的 `releaseCatalogEntrySchema`（`version`/`target`/`archiveUrl`/`archiveSha256`），但**来源是 GitHub，不是自建 catalog**——这是新增接线（仓库现有 `updatePreparation.ts:78 fetchReleaseCatalog` 走的是自建 URL schema）。
- **平台目标**：沿用 `packages/zcode-server-cli/src/runtime/manifest.ts:5` 的 `darwin/win32/linux × arm64/x64` 六元组；下载 asset 需按 `{platform}-{arch}` 选择。
- **插件级识别字段**：manifest 顶层新增 `cliProxy`（发布源、默认 channel 等），并把它映射到 `ZCodePluginInfo` 的一个**可选插件级字段**（如 `binaryPlugin`/`kind: "cliProxy"`）。该字段**只用于识别与渲染**：不进 `PluginComponentType`、不进协议组件 zod 枚举（`packages/shared/src/zcode-protocol/index.ts:2535`）、不进 `PluginComponentGroups` 徽标（`packages/ui/src/settings/PluginComponentGroups.tsx:18-33`）、不进 `enumeratePluginComponents`（`apps/zcode-cli/packages/adapters/src/plugins/plugin-components.ts:29`）。它表达的是"这个插件是哪种二进制插件"，与"该插件贡献了哪些组件"是两条正交的轴。

## 与现有插件模型的关系

复用：

- 内置插件播种与官方市场分区（`official-marketplace.ts:6,67`）：CLI Proxy 作为内置插件进官方市场，用户可见、可启停（但默认无需安装）。
- CDN/zip 外置资源的 sha256 强校验范式（`apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts:1319`）与运行时 manifest 的 `components[]{id,sha256,paths,archivePath}` 外置资源先例（`packages/zcode-server-cli/src/runtime/manifest.ts:29`）。
- 二进制基座：下载、校验、解压、版本目录、原子写指针（见上）。

不新增：

- **不新增 `PluginComponentType` 值**，不改协议 zod 组件枚举（`packages/shared/src/zcode-protocol/index.ts:2535`），不改插件详情徽标映射（`packages/ui/src/settings/PluginComponentGroups.tsx:18-33`）。
- 不改 `enumeratePluginComponents` 的组件枚举（`apps/zcode-cli/packages/adapters/src/plugins/plugin-components.ts:29`）。二进制插件不参与组件分组展示，其"是否可用/版本"由**插件详情区块**承载（不是「模型与供应商」分类页）。

### 为什么不用组件 kind

「二进制插件是否该新增一个组件 kind」的结论是**不新增**，依据：

- **语义错位**：组件模型是「该插件贡献 N 个同类条目」——`PluginComponentGroup = kind + items[]`（`packages/shared/src/zcode-protocol/index.ts:2545`）。现有 MCP/技能签展示的正是这些 items（`PluginsSection.tsx:1302-1336`/`:1338-1364`，条目级）；CLI Proxy 是「每插件一份二进制 + 多版本」，没有条目列表，硬塞会逼出"一个插件 = 一个空 items 的悬挂分组"。
- **签是插件级即可满足**：第四签「外部插件」与 `plugins` 签同为插件级（`:1276-1300`），只是过滤条件换成 `binaryPlugin != null`；无需把签绑定到组件 kind。
- **污染面**：新增 kind 要同步改 `PluginComponentType`（`packages/shared/src/plugin-types.ts:12`）、协议 zod 枚举（`zcode-protocol/index.ts:2535`）、详情徽标映射（`PluginComponentGroups.tsx:18-33`）与枚举器，并把仓库已有的 `lsp` 不一致（类型/i18n 有、协议枚举与枚举器无）问题一起放大。
- **插件页可见性无需组件**：列表不按组件过滤（`pluginCapabilityProjection.ts:20`、`PluginsSection.tsx:486`、`PluginStoreCard.tsx:292`），详情组件为空时不渲染分区（`PluginStoreDetailView.tsx:227`），且详情已有可扩展插槽先例（`PluginStoreDetailView.tsx:234`，父级 `PluginsSection.tsx:686-745` 已注入 `PluginConfigControls`）。→ 用户要的"签里可见 + 切版本"靠「插件级过滤签 + 详情版本区块」即可满足。

## 安装/卸载语义（已定，沿用）

- **术语纠正**：本能力里「安装」**不再**表示"让插件从不可用变为可用"。插件的可用性由"随应用二进制分发"决定：用户安装我们的软件后**不需要再额外安装这个插件**即可用。因此：
  - **插件整体不可关闭、不可卸载**：内置基础版本与我们打包的二进制在一起；详情页**不提供**把插件整体关掉/卸载的开关。
  - **「安装」= 下载并登记一个新版本**，属**版本级**操作，不是插件级启用开关。
- **版本来源分两类**：
  - **内置基础版本（bundled base）**：随应用二进制分发，即本 spec 的"编译期内置兜底版本"。**不可卸载、始终可用**；任何用户自行安装的版本被移除后仍回落到它。
  - **用户自行下载的版本**：用户点"安装/下载"（含更新提示里的下载）得到的版本，**可卸载**；卸载只删该版本目录与登记，不影响内置基础版本与其它版本。
- **详情页可见内容与操作**：
  - **当前 active 版本**（标注来源：内置基础 / 用户下载）；
  - **已下载版本清单**，逐行标注来源，并据此决定该行是否有「卸载」：内置基础版本**无**卸载按钮；用户下载的版本**可**卸载；
  - **更新提示与安装新版本入口**（联网检查到 GitHub 新 release 时出现；点击即"下载并登记一个新版本"）；
  - 若卸载的是当前 active 版本，active 回落到最近的可用版本（兜底为内置基础版本），并**显式提示一句**。
- **与 `PluginStoreDetailView.tsx` 的 `item.installed` 分支协调**：现有内置未安装插件在详情显示「安装」按钮（`PluginStoreDetailView.tsx` 的 `item.installed` 分支）。二进制插件在该视角下**始终处于"已可用"状态**，因此**不得**走"未安装 → 插件级安装按钮"分支（那会把版本安装误表成插件安装），也不提供可把插件整体关掉/卸载的按钮；详情主区改为渲染上面的版本管理内容。

## 「模型与供应商」新分类与 Codex 首批适配

- 在「模型与供应商」（`packages/ui/src/settings/ModelProviderSection.tsx:30`）新增一个分类/分组，标题暂定 **CLI Proxy API**。这与现有左栏硬编码分组（`model-provider-section/constants.ts:42`，仅 `opencode` | `custom`）和模板分组（`ProviderTemplatePicker.tsx:44-68`）**不同**：它是一个新的、非模板的 provider 分组。该分类**只管 provider 配置**（baseURL、api 类型、模型清单、凭据），**不承载版本选择**——版本查看与切换在「设置 → 插件」的插件详情区块（见「插件页可见性与版本管理」），两者解耦。
- 添加一个 Codex 配置后，用户即可使用 Codex 的模型：该 provider 沿用仓库现有模板范式，`api.type` 强制为 `openai-responses`（`config/provider/zcode-builtin.json` 的 `cliproxy-codex` 模板默认值即此；已建 provider 在 Registry 组装时由 `resolveCliProxyForcedApiType` 覆盖，不改存储、无双写），`endpoints.baseURL` 指向本机 CLI Proxy 端点（默认 `http://127.0.0.1:8317/v1`，只作运行时事实、不在界面展示）。（修正：旧版写的 `apiFormat: openai-completions` / `kind: openai-compatible` 是旧字段名，代码里不存在，按现有 `api.type` 范式走。）
- **依赖判定**：provider 的 baseURL 指向本机回环（`127.0.0.1`/`localhost`）即视为依赖 CLI Proxy → 需要启动；不存在 → 不启动。
- **表单（已定）**：CLI Proxy 分类的 provider 详情**不渲染连接区**——Base URL（运行时决定、含端口让位）与协议选择都不给控件。协议固定 Responses：走 `/v1/responses` 时代理无需做协议翻译、更稳定（用户拍板；v8.0.27 真机验证三端点均真实存在，但 Codex 走 responses 之外的等价性未验证）。普通供应商表单不受影响。
- **端点投影（已实现，2026-10-14 从"端口回填"扩展）**：代理启动成功（含 `EADDRINUSE`
  让位）后与运行期 provider 变更（`refresh()` 发现已 running）时，把**实际绑定端口**与
  **数据面 api-key**（`data.key`，唯一事实源）投影到 cliproxy-* provider（稀疏 overlay、
  幂等：补丁为 null 即不写；只碰回环地址的端口段与 `access.apiKey`，用户自定义地址不动，
  不触发 refresh，无循环）。运行期补投影的原因：运行中新增的依赖 provider 不会走
  `doStart`，若只在启动时投影，后加的 provider 永远拿不到 api-key。端口与密钥的事实来源
  是运行中的服务，provider 配置是它们的投影。投影逻辑在
  `resolveCliProxyProviderEndpointPatch`（`cliProxy.ts`，纯函数有单测）。

### 多渠道（2026-10-14 新增，claude/gemini/antigravity 为 beta）

二进制原生支持多上游（OAuth 浏览器授权：codex/claude/gemini/antigravity/kimi/meta/
xai/devin/antigravity；API-key：各渠道 + 通用 OpenAI 兼容）。首批只开 Codex（真机
验证过）；本节新增 **claude / gemini / antigravity** 三个 beta 渠道：

- **模板**：`cliproxy-claude`（anthropic-messages）/ `cliproxy-gemini`、
  `cliproxy-antigravity`（openai-chat-completions），endpoint 同为本机实例
  `http://127.0.0.1:8317/v1`。**协议兜底改为"模板声明优先"**：
  `resolveCliProxyForcedApiType(templateId, configApiType)` 只在 cliproxy-*
  无任何协议时兜底 openai-responses（旧版对前缀一刀切强制 Responses 已废）。
- **登录参数化**：`getAuthUrl(channel)` / `pollAuthStatus(state)` /
  `submitAuthCallback(channel, payload)` / `fetchQuota(providerId, channel)`；
  auth-url 恒带 `is_webui=true`（回调转发器机制，codex=1455、claude=54545
  见于二进制）。登录文案按渠道注入，`callback-port-busy` 文案去 1455 化。
- **beta 约定**：`CLI_PROXY_BETA_CHANNELS`（claude/gemini/antigravity）在模板
  选择器标 Beta（复用 templateBetaTag 白名单口径：未经真实账号逐渠道端到端
  验证）。codex 已真机验证不计入。
- **额度观测**：按渠道过滤 credentials（provider 字段）；非 codex 渠道 signals
  尚无解析 → 自动落 "暂无额度观测" 降级，确认各自信号键后逐渠道补。
- **gemini/antigravity 回调端口未实测**：portBusy 文案不写死端口；接入真实
  账号验证后补录端口表（`CLI_PROXY_CHANNEL_CALLBACK_PORTS`）。

### 上游代理（proxy-url，2026-10-14 新增）

CLI Proxy 出网（上游渠道，如 Codex→OpenAI）与 YCode→endpoint（回环）是两段链路：
模型级 proxyMode 只管前者之前的 YCode 一跳，管不到代理进程的出网。上游代理由
config.yaml 顶层 `proxy-url` 承载（真机确认字段存在并随 CONFIG RELOAD 热加载）：

- **Provider 级开关**：cliproxy-* 提供商规则新增 `proxyMode`（与 isPrimary 同层，
  不进执行配置体），三档语义对齐 `docs/specs/network-settings.md`：
  - `default`（未写视为它）：跟随全局「为全局启用」开关；
  - `proxy`：强制走「网络」分区填写的代理地址（地址未填则直连）；
  - `direct`：强制直连。
- **裁决**（`resolveCliProxyUpstreamProxyUrl`，纯函数有单测）：任一提供商要求代理
  即写 `proxy-url`（**代理优先**——单实例共享一个上游出口，一账号要代理就整体走代理）；
  无人要求或地址未填 → 直连。粒度是**实例级**，不按模型分流（二进制无模型级代理映射）。
- **生效时机**：启动前裁决一次写入；运行期 provider 变更（refresh 已 running）裁决变化时
  重写 config.yaml，代理 watch 热加载，无需重启进程。
- **模型级网络选项隐藏**：cliproxy-* 提供商的模型编辑弹窗不渲染代理模式选项
  （`hideProxyMode`）——该选项只作用于 YCode→endpoint（回环）一跳，对 CLI Proxy
  场景没有实际效果，保留只会误导（用户预期它管出网）；上游代理只在 Provider 级配置。
- **已知问题闭环**：此前生成 config.yaml 不写 proxy-url，代理进程又继承不到 shell 的
  HTTPS_PROXY（GUI 启动），Codex 出网直连被 OpenAI 按地区 403
  （`unsupported_country_region_territory`，真机复现）——用户"配了代理没反应"即此。

### 绑定粒度：单个共享实例 + 一账号一条 provider（已定，修正旧表述）

旧版"一实例多上游"的表述修正为：

- **实例层共享**：CLI Proxy 默认是**单个共享实例**（一进程一份 `config`，`--config` 指定；多实例需多进程多端口——我们默认单实例）。
- **provider 层一账号一条**：**一个 Codex 账号 = 一个 provider 条目**，列在「模型与供应商」的 CLI Proxy API 分类下。provider 条目是该账号在 UI 上的映射，不是新实例。
- 首批 UI 只开放 **Codex**；后续上游同样遵循"实例共享、provider 条目按账号增"。

```
┌─ CLI Proxy 实例（单个共享，本机 127.0.0.1:8317）─┐
│  config.yaml + ~/.cli-proxy-api/*.json（一账号一文件）│
└──────────────┬──────────────┬──────────────┘
               │              │
     provider 条目 A        provider 条目 B
     （Codex 账号 A）       （Codex 账号 B）
     「模型与供应商」       「模型与供应商」
     CLI Proxy API 分类     CLI Proxy API 分类
```

### 登录流程：界面内引导授权（已定）

- **界面内代跑管理面 OAuth，不经过 `--codex-login` 终端流程**；回调端口 1455 被占用或授权超时时降级提示（释放 1455 后重试）。（修正：旧版"1455 被占用时回退设备码"不成立——v8.0.27 上设备码相关管理面端点实测全 404，不保留设备码承诺。）
- 走管理面：
  - `GET /v8/management/oauth/auth-url?provider=codex` 取授权 URL 与 state（v8.0.27 真机验证返回 `{"state","status":"ok","url"}`）；
  - 轮询 `GET /v8/management/oauth/status?state=`（未完成返回 `{"status":"wait"}`）；
  - `POST /v8/management/oauth/callback` 提交。（来源：CLIProxyAPI 官方源码/文档 + v8.0.27 真机验证。）
- 注意 `POST /oauth/import` **仅支持 Vertex**，Codex 登录不走它。（来源：CLIProxyAPI 官方源码/文档。）
- 凭据落盘：**一账号一 JSON**，目录为 **`~/.ycode/cli-proxy/auth/`**（YCode 自有目录；功能未上线无兼容包袱，不再用社区默认 `~/.cli-proxy-api`）；**落盘即被代理热加载**（file watcher，真机验证 `CONFIG RELOAD` / `config successfully reloaded`），**我方不写代理 config 的账号分组**。
- 过期由代理用 refresh_token 自动续期，我方不自建续期逻辑。

### 凭据来源与下游接入（已定）

- **OAuth 类（Codex）**：经上述登录流程走浏览器授权，**一个账号一个 auth JSON**，落盘 `~/.ycode/cli-proxy/auth/`；文件内含 `type`/`email`/`access_token`/`refresh_token`/`id_token`/`account_id`（来源：CLIProxyAPI 官方源码/文档）。
- **API Key 类**：写在 `config.yaml` 顶层 `api-keys:` 下按上游分组（`base-url`/`headers`/`models[]`/`keys[].api-key`），与下游鉴权 `access.api-keys` **相互独立**（来源：CLIProxyAPI 官方源码/文档）。
- **下游不需要切换供应商**：一个 base_url（如 `http://127.0.0.1:8317/v1`）+ 一个自定 api-key + 模型名即可。
- 按请求固定走某账号靠模型名前缀 `prefix`（如 `test/gemini-3-pro-preview`）或唯一 `alias`；**没有面向下游的点名账号公开手段**。多账号路由由 `routing.strategy`（round-robin / weighted-round-robin / fill-first）+ `request-retry` + `session-affinity` 自动完成（来源：CLIProxyAPI 官方源码/文档）。

### 模型清单：动态拉取（已定）

- **不内置模型清单**，改走代理端 **`/v1/models` 动态拉取**（含缓存，失败回退到上次结果）。
- **这是新写**：现有仓库的「智能匹配」是**本地内置规则**（`packages/provider/src/facades.ts:279` 的 `resolveModelConfig`——同步、内存快照、无网络），不是接口查询；全仓**无任何 `/v1/models` 拉取实现**。
- 用户观察到的"约一秒延迟"真实成因是 `packages/ui/src/settings/model-provider-section/useIdleTrigger.ts:3` 的 **1200ms 停输入防抖**（非联网），记录在此，避免后续被误当成网络问题排查。

### 额度：只被动观测，不提供主动刷新（已定）

- **来源**：Codex 上游响应带 `rate_limits{primary/secondary{used_percent,window_minutes,reset_after_seconds/reset_at},limit_reached}` 与 `credits/plan_type`；代理在 `internal/runtime/executor/helps/codex_quota.go`（CLIProxyAPI 官方源码）归一化为 `X-Codex-*` 头（`Primary/Secondary-Used-Percent`、`*-Window-Minutes`、`*-Reset-After-Seconds/Reset-At`、`Limit-Reached`、`Plan-Type`、`Active-Limit`、`Credits-Balance`），再由 `sdk/cliproxy/auth/quota_signals.go:ObserveResponseHeadersForProvider`（CLIProxyAPI 官方源码）存为该凭据的快照，**替换语义而非累积**。
- **读取**：`GET /v8/management/credentials`（`Authorization: Bearer <management-key>` 或 `X-Management-Key`，v8.0.27 真机验证两者均 200），条目形如 `quota = {observed_at(RFC3339), signals}`，另有逐模型 `model_quotas`；多账号逐条读。（来源：CLIProxyAPI 官方源码/文档 + 真机验证；`credentials` 返回里额度字段的确切键名需实测，见未决问题。）
- **真机形态（v8.0.27 实测）**：空实例返回 `{"files":[],"observed_at":"..."}`；条目顶层 `quota.signals` 无观测时为空对象 `{}`；`model_quotas` 无数据时整个字段缺席（读取按可选处理）；`secret-key` 明文启动后会被代理改写成 bcrypt 哈希。
- **触发条件（产品规则）**：仅在**真实补全响应**上观测（调用点 `auth/conductor_cooldown.go:1035`，CLIProxyAPI 官方源码）。`GET /v1/models`、5xx、传输失败都不刷新，保持旧快照；准备失败路径显式置 `SkipQuotaObservation`。因此"连通性测试顺带刷新额度"**只有在该测试发的是真实补全（极小 max_tokens）时成立**，并会消耗极小上游用量；若测试只调 `/v1/models` 则不刷新。
- **窗口区分（重要纠正）**：不要硬编码 primary=5h。代理只是按上游字段名循环输出 primary/secondary（`codex_quota.go:180`，CLIProxyAPI 官方源码），未绑定窗口时长；某档位只有一个窗口时就是少一个槽位。正确做法是读 `*-Window-Minutes` 自行归类（300≈5 小时、10080≈7 天）。注意该头**非必有**：需 `used_percent`+`window_minutes`+`reset_after/at` 同时合法才收录，缺一即丢弃该窗口。`Active-Limit` 取上游 `metered_limit_name`，是"当前生效的 limit 名"而非窗口时长；`Plan-Type` 原样透传（见过 `free/plus/team/business/go`，另有 `pro`）。档位与窗口数量的对照表在源码中**不存在**，标为未确认。
- **时效**：无 TTL；**重启后代理内存快照清空**（2026-10-14 实测：credentials 的
  quota.signals 清空）。但 UI 承诺的是"最后一次观测值"——**打开软件立刻可见，不得要求
  先发一次请求**（用户明确要求）。因此 Host 在每次成功读取到窗口时把合并快照落盘为
  `{cli-proxy 根}/quota-snapshot.json`（0600，按渠道分条），之后的读取在 live 无窗口
  （代理未启动/重启后无观测/管理面失败/无凭据）时回落这份缓存：observedAt 是旧值，
  界面按"N 小时前观测"如实呈现；下一次真实请求自动覆盖。
- **展示**：tooltip 只显示**最后一次观测值** + 友好化时间（"5 分钟前""1 分钟内"这类）；无数据时显示"—"。不做定时轮询；打开设置页时拉一次，页面可见时低频兜底，代理未启动不拉。

额度观测事件顺序：

```
用户真实补全请求
  → 上游 Codex 响应（含 rate_limits / credits 头）
  → 代理归一化为 X-Codex-* 头（codex_quota.go）
  → 快照替换存入该凭据（quota_signals.go，替换非累积）
  → 我方 GET /v8/management/credentials 读取 quota{observed_at, signals}
  → tooltip 显示最后一次观测值 + 友好化时间

注：/v1/models、5xx、传输失败不触发观测，快照保持不变。
```

### 模型名与展示（已定）

- **不改模型 id**。代理转发前会剥离前缀（`auth/conductor_models.go:rewriteModelForAuth` 的 `TrimPrefix`，CLIProxyAPI 官方源码），上游收到的是真名。
- **不向模型注入自我身份**：在 `packages/provider`、`packages/services` 搜过，无此类 system prompt，所以不存在"模型自我认知错乱"。副作用只在下游展示。
- 我们的展示名直接由 id 派生（`packages/ui/src/lib/modelDisplayName.ts:63`），没有展示名/请求名分离字段。所以区分账号用 **provider 名 + 模型条目自带的 `name` 字段**。
- 代理侧 `models[].alias` 是给下游看的名字、`name` 才是上游真名，属换壳，不改变可用模型（来源：CLIProxyAPI 官方源码/文档）。

## 事件顺序与生命周期

```
应用启动（Host 初始化）
  └─ CliProxyService.bootstrap()
       ├─ 读取专属落盘：activeVersionId / downloadedVersions[]
       ├─ 解析 active 版本：downloaded[最新或用户所选] ?? 编译期内置兜底版本
       ├─ 启动时自动追新：内置版本落后 → 下载最新版 → 征得用户同意后切 active
       ├─ 判定是否需要启动：模型供应商里是否存在依赖 CLI Proxy 的 provider？
       │     ├─ 否 → 停在此处，不监听端口（按需启动的核心）
       │     └─ 是 → start()
       │           ├─ 选定监听地址与端口（127.0.0.1:<端口>，只绑本机）
       │           ├─ 生成/读取代理令牌（独立落盘文件，0600）
       │           ├─ 写 v8 嵌套 config.yaml（`config-version: 8` + `server.host/port`；
       │           │   真二进制无 `--port` 参数，端口只走配置文件）
       │           ├─ spawn 二进制（active 版本目录内的可执行文件，仅传 `--config`）
       │           ├─ 就绪行 `API server started successfully on: <host>:<port>` + 2s 存活确认 → state = running
       │           │   （端口冲突时它先打印就绪行、约 1s 后 bind 失败退出：必须延迟确认，否则误判）
       │           └─ 失败 → state = error（不改用户意图）
       └─ 更新检查：启动时一次 + 每日一次（现有更新提示通道，不单独做角标）

用户在「模型与供应商」添加 Codex 配置（一账号一条 provider）
  ├─ 界面内引导授权（管理面 OAuth 三步；回调端口被占时降级提示，不承诺设备码）
  ├─ 凭据落盘即被代理热加载（不写代理 config 的账号分组）
  └─ 触发依赖判定重算：需要 → start()（含 EADDRINUSE 让位 + 端点投影：按实际端口与
      data.key 投影 provider 的 baseURL/access.apiKey）；运行中新增依赖 provider 时
      refresh() 补一次投影；移除最后一个依赖 provider → stop()
  └─ error 态可重试：启动失败进入 error 后，后续 refresh()/getCodexAuthUrl() 仍按 needed 重试
      start（error 不是终态；只有 !needed 才 stop）。首次下载的版本若此前无 active，
      直接成为 active（否则自动下载永远用不上，binary-missing 卡死）。
  └─ 启动期最多一次更新检查网络请求（后台执行，不阻塞按需启动；真机复现 2026-10-14：
      上游 8.0.28 > 内置 8.0.27 触发追新下载，await 检查会把 refresh 卡在下载上，
      依赖 provider 已存在代理也永不启动，故 resume 只触发不等待）：
      resumeIfEnabled 已触发更新检查后，doStart 的首启下载复用其 in-flight 结果
      （updateCheckInFlight 去重），不再发第二次请求（离线时不叠加两次超时）。
  └─ 检查成功语义：只有当更新检查真正完成（取到上游 latestVersion）才记为
      “启动期已检查”，失败（断网/限流）不置位；首启下载失败也不永久锁死，
      下次 refresh 距上次尝试超过退避间隔（5 分钟）可再试一次——断网恢复后
      无需人工干预自愈，同时不变成每次 refresh 都发请求的高频重试。
  └─ management-key-missing 有独立指引文案：本机管理面密钥文件缺失/不可读，
      重试必然再失败，用户出路是重启应用（重建密钥）或检查数据目录权限，
      不得并入通用“请重试”。
  └─ 登录失败文案必须按码渲染：loginError 是联合类型
     （callback-port-busy / desktop-only / proxy-stopped / management-key-missing / failed），
      服务层未知错误统一落 failed、原文只进日志；UI 禁止渲染 loginError 原文，
      未映射的码一律走通用失败文案，不得把机器码上屏。

用户真实补全 → 额度快照替换 → 设置页打开时拉 credentials → tooltip 显示

用户切换版本（默认最新）
  └─ CliProxyService.selectVersion(id)
       ├─ 写 activeVersionId 落盘（旧版本目录保留）
       └─ 若正在运行：停止 → 用新版本 start()（同端口重建）

用户下载新版本（更新提示）
  └─ CliProxyService.downloadRelease(entry)
       ├─ releaseDownload 下载 + sha256 校验
       ├─ componentCache 安全解压到 releases/<version>-<target>-<sha12>/
       └─ 落盘 downloadedVersions[]（不自动切 active，除非用户选择）

应用退出
  └─ CliProxyService.stop()（停止二进制进程）
```

- 运行时状态唯一所有者是 Host 的 `CliProxyService`；UI 只渲染其快照，所有变更经 RPC 落回 Host（沿用远控 UI 不持状态的范式，`docs/specs/mobile-remote-control.md:59`）。
- 与远控的差异：远控的 `enabled` 是**用户显式开关**，CLI Proxy 的"是否需要运行"是**从供应商配置派生**；因此没有"用户点开启/停止"的持久化意图字段，只有 active 版本与已下载版本清单落盘。

## 平台与安全边界

- **下载与校验**：复用 `releaseDownload.ts:96`（`.part` 临时文件、size 校验 :122、sha256 :135、退避重试）与 `componentCache.ts:175`（zip/tar 安全解压、path 穿越与 symlink 校验）。下载 asset 的 sha256 必须来自可信来源（GitHub release 的 checksum asset 或我方发布清单），不得只信任下载内容自證。
- **下载需支持标准代理环境变量**：`HTTPS_PROXY`/`HTTP_PROXY`（大小写均可）+ `NO_PROXY`（含 `*` 通配）。本机直连 github.com 被拒、需经本地代理（如 `localhost:7890`）的网络下，应用内下载若不支持这些变量必失败。实现为下载链路的唯一代理入口（`packages/services/src/cli-proxy/cliProxyInstall.ts` 的 `resolveDownloadProxyDispatcher`，undici `ProxyAgent`），纯函数可单测。
- **监听地址与令牌**：只绑 `127.0.0.1`；管理面必须设 secret-key（留空则整个管理面 404，但我们需要它，所以必须设）；`management.allow-remote:false`（默认）只允许本机访问管理面；数据面用 `access.api-keys`。（来源：CLIProxyAPI 官方源码/文档。）
- **传输层限制**：它只支持 TCP 监听（`internal/api/server.go:297` 的 `net.Listen("tcp", addr)`，CLIProxyAPI 官方源码），没有 Unix socket，TCP 关不掉。
- **桌面端固有边界（修正，显式接受）**：同机同用户下的进程既能连 127.0.0.1:8317，也能直接读 `config.yaml` 与 `~/.cli-proxy-api/*.json`，因此"不让外部知道"**做不到**，不要做虚假承诺。目标写为：网络不可达（仅本机）+ 必须带令牌 + 关键文件权限 0600，并显式接受"同机同用户进程可见"这一桌面端固有边界。
- **可复用 vs 不可复用**：可复用远控的"固定端口落盘、`EADDRINUSE` 让位、凭据独立落盘、401 门禁"（`docs/specs/mobile-remote-control.md:27-29,68`）；不可复用其 cookie 会话、暴露 YCode 服务的 WebSocket、浏览器 origin 锁定。
- **负面边界**：不在未配置任何依赖供应商时监听端口；不把代理端点暴露到局域网；不自动下载/自动替换版本；不在用户未确认时切换 active 版本。

### macOS：无签名裸二进制 + ad-hoc 签名（已定，重写旧假设）

旧版"quarantine 会拦"的假设推翻，重写如下：

- 上游 `router-for-me/CLIProxyAPI` 的 macOS 资产是 tar.gz 里的**裸二进制、完全无签名**（`.github/workflows/release.yaml` 无 `codesign`/`notarytool`/`stapler`，仅 `checksums.txt`，无官方 brew cask）。（来源：CLIProxyAPI 官方源码。）
- 但 **quarantine 在本场景不触发**：隔离标记由写入方主动设置，我们自己的下载路径是 Node `fetch`+`fs` 流写盘（`packages/zcode-server-cli/src/runtime/releaseDownload.ts:96`），全程无 `xattr`/quarantine 调用，且应用未声明 `LSFileQuarantineEnabled`（`packages/desktop/electron-builder.config.js:670-703` 的 `mac.extendInfo` 只有 `NSAppleEventsUsageDescription`）。
- **真实风险是另外两条**：① Apple Silicon 上未签名的 arm64 二进制会被内核拒绝执行（与 quarantine 无关），需我们做 ad-hoc 签名；② zip 解压路径强制 `0o600`（`componentCache.ts:163`）会让二进制不可执行，而 tar.gz 路径由系统 tar 保留 `0o755`（`componentCache.ts:190`）。
- 所以处理定为：**sha256 校验 + 解压后确保可执行位 + ad-hoc 签名（`codesign -s -`）；不做去 quarantine，也不要开启 `LSFileQuarantineEnabled`**。

## 待确认默认值（已收敛，仅保留真正未定）

1. ~~选版本 UI 归属~~：**已定**——「设置 → 插件」的插件详情区块内。
2. ~~Codex 模型清单~~：**已定**——动态拉取 `/v1/models`。
3. ~~代理令牌存储~~：**已定**——独立落盘文件，0600；管理面 key 不进 provider 配置，数据面 api-key 投影到依赖 provider 的 `access.apiKey`（见「端点投影」）。
4. ~~编译期内置兜底版本的存在~~：**已定**——有；未定的是打包与随应用升级的具体机制（见未决问题）。
5. ~~更新检查频率与提示方式~~：**已定**——启动时一次 + 每日一次，走现有更新提示通道，不单独做角标。
6. ~~macOS quarantine 策略~~：**已定**——不做去 quarantine；做 sha256 校验 + 可执行位 + ad-hoc 签名。
7. ~~安装/卸载语义~~：**已定**（见「安装/卸载语义」）。
8. ~~绑定粒度~~：**已定**——单个共享实例 + 一账号一条 provider。
9. ~~第四签~~：**已定**——独立第四签「外部插件」，插件级过滤 `binaryPlugin != null`。
10. ~~Codex 登录流程~~：**已定**——界面内引导授权（管理面 OAuth 三步；回调端口被占时降级提示，不承诺设备码）。

## 真机验证结论（v8.0.27，2026-10-13）

- 启动只接受 `--config`；就绪行 `API server started successfully on: 127.0.0.1:<port>`；端口冲突先打印就绪行、约 1s 后才报 `bind: address already in use`（必须延迟 2s 确认存活）。
- 配置文件是 v8 嵌套结构（`config-version: 8` + `server.host/port`）；启动后管理面 `secret-key` 明文被改写成 bcrypt 哈希；改 config 文件触发 `CONFIG RELOAD` / `config successfully reloaded`（热加载可用）。
- 数据面带 `access.api-keys` 调 `GET /v1/models` 返回 200，结构 `{"data":[...],"object":"list"}`。
- 管理面 `/v8/management/credentials` 用两种鉴权头均 200；空实例 `{"files":[],"observed_at":"..."}`；条目 `quota:{signals:{}}`（无观测时空对象），`model_quotas` 缺席。
- `GET /v8/management/oauth/auth-url?provider=codex` 返回 `{"state","status":"ok","url"}`；`status?state=` 未完成返回 `{"status":"wait"}`。
- 设备码相关管理面端点（`oauth/device*` 四个候选路径）实测全 404，不实现设备码回退。
- 本机直连 github.com 被拒，经 `localhost:7890` 代理可下载（应用内下载必须支持代理环境变量）。

## Web/移动端边界（已定）

- **仅桌面可添加**：CLI Proxy API 分类的供应商新增入口只在桌面端开放。判定取 `!isDesktop || isRemoteWorkspace`（`ModelProviderSection` 经 `SettingsPage` 透传；`isDesktop` 为全仓 UI 区分桌面/Web 的规范做法，Web 产物恒为 `false`，手机远控跑的正是这份 Web 产物，天然覆盖）。
- **原因**：代理进程、凭据目录（`~/.cli-proxy-api`）、以及 OAuth 回调（硬编码 `http://localhost:1455/auth/callback`）全在桌面本机；web/手机端添加必然断在登录。
- **Web 与远端行为**：`ProviderTemplatePicker` 的 cliproxy 分组卡片 `disabled` 并附提示（`settings.modelProvider.cliproxyDesktopOnlyHint`：「请在桌面端添加」）；其它分组与桌面端行为不变。
- **Web/远端登录入口**：额度区不渲染登录按钮，仅显示桌面端提示（`settings.modelProvider.cliproxyLogin.desktopOnly`）；服务缺失时 `startLogin` 置 `failed/desktop-only` 而非静默无反应（`useCliProxyAccount.ts:63`）。
- **已存在条目仍可用**：已添加的代理条目在 web/远端仍可正常使用——聊天、模型选择、额度展示不受影响，只禁新增入口与登录。

## 已知限制

- 本仓库**无 `/v1/models` 动态拉取先例**（现有仅模板预置 + 手动添加模型）。
- **多版本保留 + 用户选 active** 在 `packages/zcode-server-cli/src/runtime/` 无先例（现仅单 `pending→current` 指针），属本 spec 需新实现的逻辑。
- 额度快照无 TTL；重启后是否恢复未确认，按不可信处理（见「额度」）。
- 档位与窗口数量的对照表在 CLIProxyAPI 源码中不存在，未确认。
- TCP 监听关不掉、无 Unix socket（`internal/api/server.go:297`，CLIProxyAPI 官方源码）；同机同用户进程可见是桌面端固有边界。

## 实现改动面

- 插件 manifest / 契约：`apps/zcode-cli/packages/contracts/src/plugins/index.ts`（`PluginManifest` 顶层加 `cliProxy`；按需判定是否扩展 `PluginSource`，:26）。
- 协议 / UI 模型：`packages/shared/src/zcode-protocol/index.ts:2555-2583`（`zcodePluginInfoSchema` 加可选插件级 `binaryPlugin` 字段）。
- UI（第四签）：`packages/ui/src/settings/PluginsSection.tsx` —— `PluginTabTarget` union 加值（`:100`）、`TabsList` 加第 4 个 `TabsTrigger` 与对应 `TabsContent`（`:1188-1223`、`:1276-1300` 为范式）、计数管线（参考 `:1120-1143` 的 `update*Count`）、新增一个插件级过滤 section 组件（复用 `PluginList`/`PluginStoreCard`，过滤 `binaryPlugin != null`）。
- UI（详情版本区块）：`packages/ui/src/settings/PluginsSection.tsx:686-745`（在 `advanced` 注入版本管理区块）、`PluginStoreDetailView.tsx:234`（插槽）。
- i18n：`settings.plugin.tab.*` 新增第四个 key（`packages/ui/src/i18n/locales/zh-CN.ts:3509-3512` 与 `en-US.ts` 对应位置）+ 版本区块文案。
- 播种：`apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts`（把 CLI Proxy 注册为内置插件）。
- 运行时（新）：Host 侧 `CliProxyService` + 新增落盘文件；下载/校验/解压/版本目录复用 `packages/zcode-server-cli/src/runtime/`；macOS 侧加 ad-hoc 签名与可执行位保障。
- **不动**：`plugin-components.ts` 与组件枚举（`PluginComponentType`、协议组件 zod 枚举、`PluginComponentGroups` 徽标、`enumeratePluginComponents`）。

## 验收场景

1. 打开「设置 → 插件」，可见**第四个签「外部插件」**；切到该签能看到 CLI Proxy 条目——**尽管它没有任何组件**；进入其详情能看到「版本管理」区块（已下载版本列表、当前 active、更新提示、切换按钮），且详情不出现空白"组件"区。
2. 冷启动且未添加任何 Codex 配置：CLI Proxy **不监听端口**，进程树里无该二进制。
3. 在「模型与供应商」的 CLI Proxy API 分类添加 Codex 配置后：界面内引导授权完成登录；CLI Proxy 自动启动并监听 `127.0.0.1:<端口>`；无令牌请求返回 401，带正确令牌可列出/调用 Codex 模型；移除该配置后服务停止、端口释放。
4. 重启应用：active 版本与已下载版本清单从专属落盘恢复；有依赖供应商时恢复监听，端口与重启前一致。
5. 首次使用（从未下载过任何版本）：版本列表出现"内置/随应用打包"的兜底版本并作为 active，功能可用（可能较旧）。
6. 联网检查发现 GitHub 新 release：详情出现可忽略的新版本提示；点下载后新版本落入 `releases/<version>-<target>-<sha12>/`，旧版本目录与兜底版本行仍在；用户未选择时 active 不自动变。
7. 在**插件详情**里切换版本：active 指针更新，旧目录保留；运行中切换会重启服务且端口不变。
8. 下载内容 sha256 与期望不符：拒绝安装并如实报错，已下载的既有版本不受影响。
9. 真实补全后打开设置页：tooltip 显示最后一次观测的额度 + 友好化时间；仅调 `/v1/models` 时额度不刷新。
10. macOS 上下载的新版本：可执行位正确、ad-hoc 签名完成，可直接启动，无需用户手动放行 quarantine。
11. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；新增单测通过。

## 未决问题（只保留真正未定）

- 档位与窗口数量对照表缺失（CLIProxyAPI 源码中不存在，需长期按 `Window-Minutes` 自行归类）。
- `credentials` 额度字段（8.0.27 实测）：条目顶层 `quota` 对象内含 `signals`（无观测时为 `{}`）；`model_quotas` 无数据时字段缺席（非空数组），读取需做可选处理；空实例返回 `{"files":[],"observed_at":"..."}`。`signals` 内具体信号键**已实测**（2026-10-14 真实补全后抓取）：为 **HTTP 头形态**——
`X-Codex-Primary-Used-Percent` / `*-Window-Minutes` / `*-Reset-After-Seconds` /
`*-Reset-At`（epoch 秒字符串）/ `X-Codex-Plan-Type` / `X-Codex-Active-Limit` /
`X-Codex-Credits-Balance` 等，值均为字符串；secondary 可能是 0 分钟空槽位。
解析器兼容头形态与早期假设的小写短横线形态两种（`parseCliProxyQuotaSignals`）。
- 内置版本打包与随应用升级的具体机制（打包路径、升级时是否覆盖）。
