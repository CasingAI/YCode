# Spec：OpenCode 套餐用量查询（Cookie + Workspace ID）

## 背景与决策

OpenCode（opencode.ai）在仓库中已是普通 api-key provider（`config/provider/zcode-builtin.json`
的 5 个 `opencode-*` 模板，模型列表齐全）。本期为它补上「套餐用量/剩余额度」能力：

- 产品形态与用户参考的第三方工具一致：用户在设置页 OpenCode 卡片上粘贴
  opencode.ai 的登录凭据（完整 Cookie 请求头；只贴原始 token `Fe26.2**…` 亦可）与
  Workspace ID（`wrk_xxx`，来自 `/workspace/{id}/go` 页面 URL），即可查看 Go 套餐
  三个窗口（rolling 5h / weekly / monthly）的已用百分比与重置时间。
- 数据路线（唯一）：`GET https://opencode.ai/workspace/<workspaceId>/go`，认 workspace
  会话 `auth`（就是用户从浏览器复制的那份 Cookie）。页面把账号状态内联成 **seroval**
  形式，Go 套餐的三个窗口长这样：
  `rollingUsage:$R[34]={status:"ok",resetInSec:7384,usagePercent:29.2,usage:350725236,limit:1200000000}`
  （weeklyUsage / monthlyUsage 同形；同一对象只内联一次，其余位置退化成纯引用 `$R[n]`）。
  映射为 rolling/weekly/monthly，带 token 绝对值。
  - 读法（`parseOpencodeUsagePage`）：先按需建 `$R[n]=<字面量>` 引用表，再对每个窗口名
    检查**所有**出现位置、逐个解出值，只接受「确实是含 `usagePercent` 的对象」的那一次。
    不依赖首次匹配，也不依赖序列化顺序。
  - 曾经的实现是「找 `monthlyUsage:` 首次出现 → 取其后第一个 `{…}` → 要求含
    usagePercent」，正是「月额度时而显示、时而不显示」的成因：同一页面里账号套餐对象
    `{monthlyUsage:null,…}` 也带同名键，它先被序列化时首次匹配落空、该窗口被静默丢弃；
    rolling/weekly 没有重名双胞胎，所以只有月度会闪。现已由上面的读法消除，
    并把被跳过的干扰项记进日志（`ignoredOccurrences`）。
  - 401/403，或 302 跳 `/auth/authorize`（实测 Cookie 失效与 Workspace ID 不对都会这样，
    远端不区分）→ `credential-stale`；其余非 2xx、网络失败、200 但读不到窗口 →
    `unavailable`。
- 已排除的路线（不要再走）：
  - **console 用量接口**（`/console/api/orgs/<orgId>/go/status`）：console 是**独立的账号
    体系**（自有登录与 `__Host-console_session`），同一账号在两边的套餐数据互不相通
    ——用户实测其 console 里根本没有这套 Go 套餐，接口对该凭据永远 401。留着只会误导。
  - `_server` server-fn 路线（`GET /_server?id=<前端产物哈希>&args=…`）实测回
    `500 {"status":500,"unhandled":true}`，其 `id` 是前端产物哈希、随前端发版漂移。
  - 官方 `/zen/go/v1/usage` JSON 接口只认 API key 不认 cookie。
  - `/workspace/<id>/go/__data.json`、`/workspace/<id>/go.json`、`/api/workspace/<id>/go`
    等 JSON 变体都不存在（404）。

- OpenCode 用量是 provider 域的独立能力：不进入官方 Z.AI/BigModel Coding Plan
  的 entitlement 链路（`usageStatsService`/`CodingPlanUsageRemainingPanel` 保持
  官方套餐专用），不在侧边栏套餐摘要混排。展示位置有两处：设置页 OpenCode
  卡片，以及聊天输入框 context 浮层（见下）。

## 状态所有者与数据流

```text
用户粘贴 Cookie 请求头（Workspace ID 可选，留空=自动定位）
  → IOpenCodeUsageService.saveCredential（renderer 经 RPC 代理，host 进程执行）
  → ICredentialService（host 加密 KV，key: opencode-usage:<providerId>，唯一所有者）
  → getSnapshot：host 进程请求该 workspace 的 Go 用量页面
    → parseOpencodeUsagePage（纯函数：seroval 引用表 + 窗口字段）
  → 内存缓存 60s 节流 → OpenCodeUsageSnapshot → 设置卡片渲染
                                     ↘ Composer context 浮层渲染
```

- Cookie 与 Workspace ID 的唯一持久化所有者是 `ICredentialService`（host 进程）。
  不写入 `provider_config.json`、不进日志、renderer 不持久化。
- 快照是派生数据：host 侧内存缓存 + UI hook 本地 state，可随时丢弃重取。
  host 缓存分两层语义：最近一次结果（成功或失败，60s TTL，用于请求节流）与
  **last-good（最近一次成功快照，按 providerId 单独保存）**。失败只覆盖「最近一次结果」，
  last-good 必须保留：错误快照回传时会补上 last-good 的窗口与 `fetchedAt`，因此
  `getSnapshot(refresh: false)` 在缓存过期但仍有展示值时**立即返回旧值**
  （stale-while-revalidate）并触发后台刷新（同 provider 去重），界面既不会退回
  「未加载」形态，也不会出现「有数/没数」来回跳。仅 `not-configured`（凭据已不存在）
  会清掉 last-good。
- 已知该凭据读不了用量（页面 401）时，后续拉取跳过请求——凭据没换结论就不会变，
  每次都白打会让刷新多等 0.3–1.5s；换凭据（`savedAt` 变化）即重新探测。只对 401 生效：
  403/302 不写入标记（403 可能是 Cloudflare 之类的暂时性拒绝；302 含 Workspace ID 写错
  的情况，改 ID 后要能立刻重试）。该标记只在内存，不持久化。
- 凭据回显只给脱敏 hint（cookie 尾 4 位 + workspace id 全文），不回传原文。

## 展示语义（设置卡片与 Composer 浮层一致）

1. last-good 展示：只有成功快照更新窗口值（host 侧 last-good + `useOpenCodeUsage` 的
   lastGood state 双份）；失败只更新错误提示，上一次的额度值保留展示。仅 `not-configured`
   （凭据已不存在）清除展示值。
2. stale-while-revalidate 闭环：UI 拿到过期成功值时（`fetchedAt` 超过 60s）自动
   强刷一次，界面随后更新为新值；刷新期间旧值与 spinner 并存。
3. 首屏不闪「未配置」：凭据存在性（hint RPC）未返回前，设置卡片不渲染配置表单，
   只显示标题行加载 spinner；确定未配置才出表单。
4. 失败态：仅显示「获取失败」类提示（错误文案按 errorKind 映射）；进入配置表单
   必须由用户手动点击「修改配置」，失败不自动弹表单。
5. 设置卡片不展示凭据脱敏信息（Workspace/Cookie 尾号）；「剩余额度」标题行左端是标题、
   右端只有「修改配置」入口（进入表单需手动点击），行内**不再有**卡片自己的刷新按钮。
6. 刷新入口统一：模型设置页顶部的页面级「刷新」按钮是唯一刷新入口，**同时刷新 OpenCode
   用量**（与官方 Coding Plan 卡片一致——页面级刷新本就 fan-out 到 Coding Plan 权益刷新）。
   实现走 `ModelProviderRefreshSignal`：`ModelProviderSectionLayout` 在刷新按钮点击时
   递增 tick，卡片内的 `useOpenCodeUsage` 订阅 tick 变化后强刷。挂载时不得因初始 tick
   重复请求（卡片挂载本来就会 load 一次）。
7. 绝对值口径：页面里的窗口带 token 绝对值（如 `usage:350725236, limit:1200000000`），
   因此卡片在百分比下会显示绝对值；`usage`/`limit` 缺失时（只有百分比）该行不渲染。
8. 打开配置表单带出已保存的 Workspace ID；**Cookie 输入留空即保留已保存凭据**
   （`saveCredential` 的 `authCookie` 为空且已有记录时沿用旧值），placeholder 用
   「留空即保留当前凭据（尾号 …xxxx）」说明。凭据原文不回流 renderer，因此无法预填输入框，
   但改 Workspace ID、重新保存都不需要重贴 Cookie。

## 接口

- `ServiceChannels.OpenCodeUsage = "opencode-usage"`；
  `IOpenCodeUsageService`（`packages/services/src/model-provider/opencodeUsageService.ts`）：
  - `getSnapshot({ providerId, refresh? })` → `OpenCodeUsageSnapshot`
  - `saveCredential({ providerId, authCookie, workspaceId })`
  - `clearCredential({ providerId })`
  - `getCredentialHint({ providerId })` → `{ cookieTail, workspaceId } | null`
    （cookieTail 是整段归一化后 Cookie 头的尾 4 位，仅用于判断「是否已配置」，UI 不展示）
- shared 类型：`packages/shared/src/opencode-usage.ts`
  （`OpenCodeUsageWindow`：key/status/usagePercent/usage/limit/resetInSec/resetAt；
  `usage`/`limit` 可空，仅当页面窗口缺该字段时为 null）。
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
    `CodingPlanUsageHeaderAction`/`CodingPlanUsageNotice`；标题「OpenCode Go 套餐用量」，
    头部「配置」入口跳设置页 model provider 区。
  - 数据拉取时机：面板内容在 HoverCard 关闭时卸载，因此首次请求发生在用户
    展开浮层时，不在 composer 挂载时请求额度；host 侧 60s 缓存继续节流。
  - percentage 展示口径与官方 meter 一致为「剩余」（`100 - usagePercent` 截断
    到 0-100）；重置时间用 adaptive 格式（当日 HH:mm，非当日日期）。
- 注册：`services/src/node.ts` 与 `desktop/src/host/remoteWorkspaceServiceCollection.ts`
  均以 `credentialService` 注入；renderer 经 `RemoteServiceAccess` 新增 getter。

## 解析契约（对齐实测样本）

- 页面载荷是 **seroval** 序列化：`rollingUsage:$R[34]={status:"ok",resetInSec:7384,
usagePercent:29.2,usage:350725236,limit:1200000000}`，同一对象后续出现时退化成 `$R[n]`。
  `parseOpencodeUsagePage` 自带一个只认 seroval 子集（对象/数组/字符串/数字/`!0`/`!1`/
  null/`$R[n]`）的递归下降解析器，不用正则取花括号，所以字符串内的花括号、嵌套对象、
  动态序号都不会误判。
- 窗口字段名固定为 `rollingUsage`/`weeklyUsage`/`monthlyUsage`（也接受带引号的键）；
  `usagePercent = 页面原值`（收敛 0-100），`resetInSec` 原样取用并由 host 换算成
  `resetAt`（ISO）；`usage`/`limit` 是页面里的 token 绝对值，缺失才置 null。
- 窗口缺 `usagePercent` 时按 absent 处理、跳过该窗口，不当作 0%；一个窗口都没有时返回
  空窗口集（调用方按 unavailable 上报，禁止当 0% 展示）。
- 每个窗口的取法回传在 `sources`（inline/reference/absent）里进日志：将来某个窗口又丢了，
  一眼能看出是页面里确实没有，还是读法没命中。
- 凭据输入归一化：接受原始 token（`Fe26.2**…`）/ 单个 `auth=xxx` / 多对 `a=b; c=d` /
  完整 `Cookie:` 头，剥掉 `Cookie:` 前缀后**原样透传用户粘贴的全部 `name=value`**。
  不做 cookie 名白名单：opencode.ai 的会话 cookie 名会变，按名字过滤会把真正管用的
  cookie 静默丢弃，表现为「凭据看着没问题但一律被拒」——这正是 2026-09-21 实测踩到的坑。
  原始 token 仅在形如 `Fe26.2**` 或 `[A-Za-z0-9._-]+` 时包装成 `auth=<token>`；
  提取不到任何 `name=value` 且不像 token 时归一化为空串，保存报「凭据无效」，
  不发出畸形请求。
- Workspace ID 归一化：接受裸 `wrk_xxx` 或含它的链接文本；**留空表示自动**——
  host 侧请求 `GET /auth`（`redirect: "manual"`），opencode.ai 对已登录会话会 302 到
  `/workspace/wrk_…`，从 Location 取出 id 后按凭据缓存在内存，后续刷新直接打页面。
  填了内容却提不出 `wrk_…` 时保存报 `opencode_usage_workspace_id_invalid`，不静默当成自动。

## 失败语义

- 401/403，或 3xx 跳转（实测 Cookie 失效与 Workspace ID 不对都会 302 到
  `/auth/authorize`，远端不区分）→ `credential-stale`：按「需重新配置」上报，保留旧快照
  不清空。不自动跟随跳转——跟随会拿到登录页的 200，把「需要重配」伪装成「暂时没有数据」。
- 非 2xx（5xx 等）/ 网络失败 / 200 但解析零窗口 → `unavailable`：可手动刷新。
  解析零窗口视为契约破坏或该 workspace 未启用 Go 套餐，不展示空额度（不得静默显示 0%）。
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
- 侧边栏摘要的 OpenCode 混排为后续增强，本期不做。
- Workspace ID 输入框保留但**可留空**（留空=按凭据自动定位默认 Workspace）；绝大多数用户
  直接留空即可，填了才会覆盖自动定位结果。

## 验收场景

1. 未配置：OpenCode 卡片显示「配置用量查询」入口，无网络请求；composer 浮层
   显示未配置提示与「配置」入口，同样不发请求。
2. 从已登录的 opencode.ai 复制整段 Cookie（Workspace ID 留空）并保存后：host 先请求
   `/auth` 拿到默认 Workspace 的 302 Location，再请求该 workspace 的 Go 页面；卡片展示
   三个窗口的已用百分比、绝对用量与重置时间；60s 内重复打开不重复发请求；`/auth` 定位
   结果按凭据缓存，后续刷新不再重复请求。凭据已失效（被跳到登录页）时界面提示重新粘贴
   凭据（不展示 0%）。
3. 凭据过期或 Workspace ID 写错（页面 401/403/302）：卡片出现过期提示并引导重新配置，
   凭据保留，重新粘贴后恢复；只对 401 记「不重复请求」标记（403/302 下次仍重试）。
4. 页面 200 但读不到任何窗口（workspace 未启用 Go 套餐 / 远端改版）按 `unavailable`
   （暂时无法获取）提示，不显示 0%；同名干扰项（如账号套餐里的 `monthlyUsage:null`）
   不得导致窗口丢失，且被跳过的干扰项进日志。
5. 全程 grep 日志与持久化文件不含 cookie 原文。
6. Composer：选中 opencode-\* provider 时输入框 context 触发器可见，展开浮层
   出现 OpenCode 三窗口 meter；切到其它 provider 后入口消失；未配置凭据时
   展开浮层只出提示，不发请求。
7. 重新打开设置页/浮层：上一次成功额度立即显示（不闪「未配置」或空白），随后
   数据过期时自动后台刷新并原位更新；刷新失败时旧值保留、仅追加错误提示，
   且不自动弹出配置表单。
8. 反复刷新不得出现「时而显示额度、时而空白」：三个窗口（含月度）在任意序列化顺序下
   都必须稳定读出，窗口集只来自页面解析结果，解析失败按 `unavailable` 上报且保留旧值
   （last-good），不做任何猜测性补全；缓存过期的下一次拉取也要先拿旧值
   （stale-while-revalidate），不出现等待网络才出数字的空白期。

## 设置页导航分组

- OpenCode provider（`templateId` 以 `opencode-` 开头的 standard-personal provider）
  在模型设置侧栏拥有独立分组「OpenCode」（i18n key
  `settings.modelProvider.opencodeTitle`），位于预置分组（智谱）与
  「自定义供应商」之间，不混入自定义供应商分组。
- 分组由 `useModelProviderNavigation` 计算；组内无 provider 时整个分组隐藏。
- 分组内条目仍是普通 custom provider：详情页、排序、状态点行为不变，仅归组不同。

## 验收场景（导航分组）

9. 存在任一 opencode-\* provider 时，侧栏出现「OpenCode」分组且该 provider 不再
   出现在「自定义供应商」下；删除全部 opencode-\* provider 后分组消失。

## 添加供应商模板分组

- 添加供应商选择器（ProviderTemplatePicker）为 `opencode-*` 模板提供独立分组
  「OpenCode」（i18n key `settings.modelProvider.templateGroup.opencode`），
  位于智谱分组之后、「其他」分组之前。
- `opencode-*` 模板不再落入「其他」分组；「自定义供应商」创建入口仍保留在
  「其他」分组顶部。

## 验收场景（模板分组）

10. 打开添加供应商选择器：OpenCode 模板出现在独立「OpenCode」分组下，
    「其他」分组不再重复列出这些模板。
