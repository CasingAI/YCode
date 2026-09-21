# Spec：OpenCode 套餐用量查询（Cookie + Workspace ID）

## 背景与决策

OpenCode（opencode.ai）在仓库中已是普通 api-key provider（`config/provider/zcode-builtin.json`
的 5 个 `opencode-*` 模板，模型列表齐全）。本期为它补上「套餐用量/剩余额度」能力：

- 产品形态与用户参考的第三方工具一致：用户在设置页 OpenCode 卡片上粘贴
  opencode.ai 登录 Cookie（`auth` 值）与 Workspace ID（`wrk_xxx`，来自
  `/workspace/{id}/go` 页面 URL），即可查看 Go 套餐三个窗口（rolling 5h /
  weekly / monthly）的已用百分比、绝对用量/限额与重置倒计时。
- 数据路线（已实测）：`GET https://opencode.ai/workspace/{wrk_id}/go` +
  `Cookie: auth=<value>`，解析页面内嵌 store state（HTML 正则）。官方
  `/zen/go/v1/usage` JSON 接口只认 API key 不认 cookie，且该路线已被产品决策否掉。
- OpenCode 用量是 provider 域的独立能力：不进入官方 Z.AI/BigModel Coding Plan
  的 entitlement 链路（`usageStatsService`/`CodingPlanUsageRemainingPanel` 保持
  官方套餐专用），不在侧边栏套餐摘要混排。展示位置有两处：设置页 OpenCode
  卡片，以及聊天输入框 context 浮层（见下）。

## 状态所有者与数据流

```text
用户粘贴 Cookie + Workspace ID（设置卡片草稿）
  → IOpenCodeUsageService.saveCredential（renderer 经 RPC 代理，host 进程执行）
  → ICredentialService（host 加密 KV，key: opencode-usage:<providerId>，唯一所有者）
  → getSnapshot：host 进程 GET opencode.ai → parseOpencodeGoUsageHtml（纯函数）
  → 内存缓存 60s 节流 → OpenCodeUsageSnapshot → 设置卡片渲染
                                     ↘ Composer context 浮层渲染
```

- Cookie 与 Workspace ID 的唯一持久化所有者是 `ICredentialService`（host 进程）。
  不写入 `provider_config.json`、不进日志、renderer 不持久化。
- 快照是派生数据：host 侧内存缓存 + UI hook 本地 state，可随时丢弃重取。
  host 缓存分两层语义：最近一次结果（成功或失败，60s TTL，用于请求节流）与
  last-good（最近一次成功快照）。`getSnapshot(refresh: false)` 命中过期 last-good
  时**立即返回旧值**（stale-while-revalidate）并触发后台刷新（同 provider 去重），
  不得让 UI 退回「未加载」形态。
- 凭据回显只给脱敏 hint（cookie 尾 4 位 + workspace id 全文），不回传原文。

## 展示语义（设置卡片与 Composer 浮层一致）

1. last-good 展示：只有成功快照更新窗口值（`useOpenCodeUsage` 内部 lastGood state）；
   失败只更新错误提示，上一次的额度值保留展示。仅 `not-configured`（凭据已不存在）
   清除展示值。
2. stale-while-revalidate 闭环：UI 拿到过期成功值时（`fetchedAt` 超过 60s）自动
   强刷一次，界面随后更新为新值；刷新期间旧值与 spinner 并存。
3. 首屏不闪「未配置」：凭据存在性（hint RPC）未返回前，设置卡片不渲染配置表单，
   只显示标题行加载 spinner；确定未配置才出表单。
4. 失败态：仅显示「获取失败」类提示（错误文案按 errorKind 映射）；进入配置表单
   必须由用户手动点击「修改配置」，失败不自动弹表单。
5. 凭据脱敏信息（Workspace + Cookie 尾号）与「修改配置」按钮并入「剩余额度」
   标题行，不单独占行。

## 接口

- `ServiceChannels.OpenCodeUsage = "opencode-usage"`；
  `IOpenCodeUsageService`（`packages/services/src/model-provider/opencodeUsageService.ts`）：
  - `getSnapshot({ providerId, refresh? })` → `OpenCodeUsageSnapshot`
  - `saveCredential({ providerId, authCookie, workspaceId })`
  - `clearCredential({ providerId })`
  - `getCredentialHint({ providerId })` → `{ cookieTail, workspaceId } | null`
- shared 类型：`packages/shared/src/opencode-usage.ts`
  （`OpenCodeUsageWindow`：key/status/usagePercent/usage/limit/resetInSec/resetAt）。
- UI 卡片视觉复用官方单卡组件 `PlanUsageMetricCard`（StatusCards.tsx，已导出）：
  窗口投影为 `UsageQuotaLimit`（`type: "OPENCODE_USAGE"`，percentage=已用占比同官方口径，
  nextResetTime 毫秒），色板与重置时间格式对齐官方 Coding Plan 卡；凭据配置表单与
  错误提示是本区块特有部分。外层 `CodingPlanUsageSummaryCards` 绑定官方重置机会/MCP
  语义，不复用。
- 判定：`isOpenCodeProviderTemplateId(templateId)`（`opencode-` 前缀，shared）。
  所有 `opencode-*` 模板卡片均提供该区块；查的是账号级 Go 套餐额度。
- Composer context 浮层入口（`ChatContextUsage` 新增可选 `openCodeUsage` 配置）：
  - 挂载条件：当前选中 provider 实例的 `templateId` 命中
    `isOpenCodeProviderTemplateId`（`V4ComposerToolbar` 从 `modelSelectionView`
    按 `effectiveConfig.provider` 查实例）。选中非 OpenCode provider 时不渲染入口、
    不发请求。
  - 展示件复用官方 `ChatCodingPlanUsageMeter`（已导出）与
    `CodingPlanUsageHeaderAction`/`CodingPlanUsageNotice`；标题「OpenCode 套餐用量」，
    头部「配置」入口跳设置页 model provider 区。
  - 数据拉取时机：面板内容在 HoverCard 关闭时卸载，因此首次请求发生在用户
    展开浮层时，不在 composer 挂载时请求额度；host 侧 60s 缓存继续节流。
  - percentage 展示口径与官方 meter 一致为「剩余」（`100 - usagePercent` 截断
    到 0-100）；重置时间用 adaptive 格式（当日 HH:mm，非当日日期）。
- 注册：`services/src/node.ts` 与 `desktop/src/host/remoteWorkspaceServiceCollection.ts`
  均以 `credentialService` 注入；renderer 经 `RemoteServiceAccess` 新增 getter。

## 解析契约（对齐实测样本）

- 页面内嵌形如 `rollingUsage:$R[34]={status:"ok",resetInSec:10194,usagePercent:5.8,usage:69820486,limit:1200000000}`；
  `usagePercent` 与 `resetInSec` 存在两种字段顺序，`$R[n]` 序号动态，必须双正则兼容。
- `usage`/`limit` 可能缺失（只解析到百分比时置 null），UI 在无绝对值时只展示百分比。
- Cookie 输入接受三种形态：裸值 / `auth=<value>` / 整段 `Cookie:` 头，归一化为
  `auth=<value>`。

## 失败语义

- 401/403 → `credential-stale`：卡片提示「Cookie 已过期，请重新粘贴」，保留旧快照不清空。
- 404 → `workspace-not-found`：提示检查 Workspace ID。
- 网络/解析失败 → `unavailable`：展示通用错误，可手动刷新；解析零窗口视为解析失败，
  不展示空额度（HTML 改版属于契约破坏，需人工跟进，不得静默显示 0%）。
- 未配置凭据 → `not-configured`：展示配置入口，不发请求。
- 所有失败路径在 UI 上都不得清除已展示的窗口值（last-good），错误提示与旧值并存；
  配置表单只在用户手动点「修改配置」或确认未配置时出现。

## 不变量

1. 凭据明文只存在于用户输入框与 `ICredentialService`；日志、错误消息、快照、
   persist 层一律不含 cookie 原文。
2. 请求只在 host 进程发出，renderer 不直连 opencode.ai。
3. 不改动官方 Coding Plan entitlement 链路的任何行为。
4. `IOpenCodeUsageService` 不得依赖 UI 或 provider Registry；凭据按 providerId
   隔离，删除 provider 时的凭据清理随 `clearCredential` 由 UI 触发。

## 迁移边界

- 不改 `zcode-builtin.json`（模板已完整）、不改 provider schema。
- 侧边栏摘要的 OpenCode 混排、workspace id 自动发现（`/_server` 拉取工作区列表）
  为后续增强，本期不做。

## 验收场景

1. 未配置：OpenCode 卡片显示「配置用量查询」入口，无网络请求；composer 浮层
   显示未配置提示与「配置」入口，同样不发请求。
2. 粘贴有效凭据保存后：卡片展示三个窗口的百分比、绝对用量/限额、重置倒计时；
   60s 内重复打开不重复发请求。
3. Cookie 过期（401/403）：卡片出现过期提示，凭据保留，重新粘贴后恢复。
4. Workspace ID 错误（404）：提示检查 ID；解析零窗口按不可用处理，不显示 0%。
5. 全程 grep 日志与持久化文件不含 cookie 原文。
6. Composer：选中 opencode-\* provider 时输入框 context 触发器可见，展开浮层
   出现 OpenCode 三窗口 meter；切到其它 provider 后入口消失；未配置凭据时
   展开浮层只出提示，不发请求。
7. 重新打开设置页/浮层：上一次成功额度立即显示（不闪「未配置」或空白），随后
   数据过期时自动后台刷新并原位更新；刷新失败时旧值保留、仅追加错误提示，
   且不自动弹出配置表单。

## 设置页导航分组

- OpenCode provider（`templateId` 以 `opencode-` 开头的 standard-personal provider）
  在模型设置侧栏拥有独立分组「OpenCode」（i18n key
  `settings.modelProvider.opencodeTitle`），位于预置分组（智谱）与
  「自定义供应商」之间，不混入自定义供应商分组。
- 分组由 `useModelProviderNavigation` 计算；组内无 provider 时整个分组隐藏。
- 分组内条目仍是普通 custom provider：详情页、排序、状态点行为不变，仅归组不同。

## 验收场景（导航分组）

8. 存在任一 opencode-\* provider 时，侧栏出现「OpenCode」分组且该 provider 不再
   出现在「自定义供应商」下；删除全部 opencode-\* provider 后分组消失。

## 添加供应商模板分组

- 添加供应商选择器（ProviderTemplatePicker）为 `opencode-*` 模板提供独立分组
  「OpenCode」（i18n key `settings.modelProvider.templateGroup.opencode`），
  位于智谱分组之后、「其他」分组之前。
- `opencode-*` 模板不再落入「其他」分组；「自定义供应商」创建入口仍保留在
  「其他」分组顶部。

## 验收场景（模板分组）

9. 打开添加供应商选择器：OpenCode 模板出现在独立「OpenCode」分组下，
   「其他」分组不再重复列出这些模板。
