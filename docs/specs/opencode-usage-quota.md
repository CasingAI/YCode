# Spec：OpenCode 套餐用量查询（Console Cookie + Workspace 选择）

## 背景与决策

OpenCode（opencode.ai）在仓库中已是普通 api-key provider（`config/provider/zcode-builtin.json`
的 5 个 `opencode-*` 模板，模型列表齐全）。本期为它提供「套餐用量/剩余额度」能力：

- **2026-09-22 实测：主站登录体系已下线**。旧路线「`GET /workspace/<workspaceId>/go`
  页面 + 主站 `auth` cookie」整体失效（`/auth` 与 Go 页面一律 302 到
  `/console/login`，seroval 页面解析随之作废，`parseOpencodeUsagePage` 已删除）。
- 数据路线（唯一）：**console JSON API**，认 `__Host-console_session` cookie
  （用户从浏览器复制的整段 Cookie 请求头里带着它）：
  - Workspace 列表：`GET https://opencode.ai/console/api/orgs` →
    `[{id:"wrk_…", name:"…"}, …]`（只保留 `wrk_` 前缀的条目，`org_` 是组织、没有 Go 套餐）。
  - 用量：`GET https://opencode.ai/console/api/go/status`，**Workspace ID 放在
    `x-org-id` 请求头里**（不在 query；实测把 id 放 query/路径都是 400/404）→
    ```json
    {
      "access": {
        "endsAt": "…",
        "meters": {
          "fiveHour": {
            "resetsAt": "…",
            "limitMicroCents": "1200000000",
            "usedMicroCents": "28055702"
          },
          "week": {
            "resetsAt": "…",
            "limitMicroCents": "3000000000",
            "usedMicroCents": "780081117"
          },
          "month": {
            "limitMicroCents": "6000000000",
            "usedMicroCents": "782742674"
          }
        }
      }
    }
    ```
  - 窗口映射：`fiveHour→rolling`、`week→weekly`、`month→monthly`。
    `usagePercent = used/limit*100`；`usage`/`limit` 取 `*MicroCents` 的数值原样
    （不做单位换算——数值口径与旧页面 token 绝对值一致，滚动窗口 1.2e9、周 3e9、
    月 6e9 与旧页面完全相同）；`resetAt = resetsAt`（month 实测可缺失 → null），
    `resetInSec` 由 resetsAt 与请求时刻换算，已过期截为 0。
  - 修正旧结论：此前 spec 写「console 接口对本凭据永远 401」是因为路径猜错了
    （`/console/api/orgs/<orgId>/go/status` 不存在）；真实接口是 `x-org-id` 头形式，
    2026-09-22 用真实凭据实测 200。
- 已排除的路线（不要再走）：
  - 旧主站页面路线（见上），主站登录已下线。
  - `_server` server-fn 路线：其 `id` 是前端产物哈希、随前端发版漂移（且主站下线后无意义）。
  - 官方 `/zen/go/v1/usage` JSON 接口只认 API key 不认 cookie。
- **产品形态**：设置页 OpenCode 卡片粘贴整段 Cookie 后，Workspace 改为**下拉选择**：
  Cookie 输入变化（防抖）后 host 自动拉取列表，用户直接选；Selector 右侧有刷新小按钮。
  Workspace 留空（「自动」）时 host 取列表里第一个 `wrk_` 条目作为默认 Workspace。
  Cookie 与所选 Workspace 的唯一持久化所有者是 `ICredentialService`。
- OpenCode 用量是 provider 域的独立能力：不进入官方 Z.AI/BigModel Coding Plan
  的 entitlement 链路（`usageStatsService`/`CodingPlanUsageRemainingPanel` 保持
  官方套餐专用），不在侧边栏套餐摘要混排。展示位置有两处：设置页 OpenCode
  卡片，以及聊天输入框 context 浮层（见下）。

## 状态所有者与数据流

```text
用户粘贴 Cookie 请求头（Workspace 由下拉选择，可留空=自动）
  → IOpenCodeUsageService.saveCredential / listWorkspaces（renderer 经 RPC 代理，host 进程执行）
  → ICredentialService（host 加密 KV，key: opencode-usage:<providerId>，唯一所有者）
  → getSnapshot：host 进程 GET /console/api/go/status（x-org-id: <workspaceId>）
  → JSON meters 映射为 rolling/weekly/monthly 三窗口
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
- 设置页按 `selectedNodeKey` 重挂载详情子树时，renderer 通过一个**展示投影缓存**同步恢复
  额度首帧：外层 key 是 `IOpenCodeUsageService` 实例，内层 key 是 `providerId`，只保存
  `lastGood`、错误类别与脱敏凭据 hint。该投影可丢弃、不是持久化或第二份业务事实；命中后
  仍会请求 host 做新鲜度校验。Cookie/草稿、表单展开态、Workspace 列表、loading/saving
  与请求 Promise 不得进入投影。切换 provider 必须同步读取目标 provider 的 entry，未命中时
  返回空态，绝不显示上一 provider 的额度。每次请求领取 provider 级 generation，只有最新
  generation 能提交；`not-configured` 或清除凭据删除对应 entry 并使旧请求失效。
- 已知该凭据读不了用量（401）时，后续拉取跳过请求——凭据没换结论就不会变。
  换凭据（`savedAt` 变化）即重新探测。只对 401 生效：403 可能是暂时性拒绝。
  该标记只在内存，不持久化。
- Workspace 列表（`listWorkspaces`）结果按归一化后的 Cookie 串缓存在 host 内存
  （60s TTL + in-flight 去重）：用户在输入框里连续打字（防抖后的每次触发）与
  点刷新按钮共享同一缓存，不打爆 console。
- 凭据回显只给脱敏 hint（cookie 尾 4 位 + workspace id 全文），不回传原文。

## 展示语义（设置卡片与 Composer 浮层一致）

1. last-good 展示：只有成功快照更新窗口值（host 侧 last-good + renderer 展示投影）；
   失败只更新错误提示，上一次的额度值保留展示。仅 `not-configured`（凭据已不存在）
   清除展示值。
2. renderer 投影连续性：详情子树因供应商选择而重挂载时，`useOpenCodeUsage` 必须在首次
   render 同步读取当前 `providerId` 的展示投影，使该 provider 上次成功额度在首帧直接可见；
   未命中投影的冷启动仍走空态加载。后续 effect 始终请求 host，投影命中不等于跳过校验。
3. stale-while-revalidate 闭环：UI 拿到过期成功值时（`fetchedAt` 超过 60s）自动
   强刷一次，界面随后更新为新值；刷新期间旧值与 spinner 并存。
4. 首屏不闪「未配置」：凭据存在性（hint RPC）未返回前，设置卡片不渲染配置表单，
   只显示标题行加载 spinner；确定未配置才出表单。投影命中时可同步显示「修改配置」；
   投影未命中时仍按冷启动规则处理。
5. 失败态：仅显示「获取失败」类提示（错误文案按 errorKind 映射）；进入配置表单
   必须由用户手动点击「修改配置」，失败不自动弹表单。
6. 设置卡片不展示凭据脱敏信息（Workspace/Cookie 尾号）；「剩余额度」标题行左端是标题、
   右端只有「修改配置」入口（进入表单需手动点击），行内**不再有**卡片自己的刷新按钮。
7. 刷新入口统一：模型设置页顶部的页面级「刷新」按钮刷新用量（走
   `ModelProviderRefreshSignal`，同官方 Coding Plan 卡片）；**Workspace 下拉旁的
   刷新小按钮只刷新 Workspace 列表**，不刷新用量。
8. 绝对值口径：窗口带远端绝对值（`usage`/`limit`），卡片在百分比下显示绝对值；
   缺失时（只有百分比）该行不渲染。
9. 打开配置表单带出已保存的 Workspace 选择；**Cookie 输入留空即保留已保存凭据**。
   凭据原文不回流 renderer，因此无法预填输入框，但改 Workspace、重新保存都不需要
   重贴 Cookie。
10. Workspace 下拉语义：

- 首项固定为「自动（列表首项）」（值为空串），其后是 `wrk_` 列表。
- 触发器只回显名称，不回显选项全文；名称缺失或与 ID 相同时退化为缩短 ID
  （`wrk_01KZEM26…4ZKW`）。整段 `wrk_` 会把选择器撑满并盖掉名称。
- 下拉选项文案为「名称 (缩短 ID)」。
- 选择不在当前列表里（列表未拉到/远端变更）时补一个缩短 ID 的兜底项，不丢选中值。
- Cookie 输入防抖 600ms 后自动触发 `listWorkspaces`（草稿非空用草稿；草稿为空且
  已配置时用已保存凭据）；已配置时打开表单即自动拉一次；**未配置且草稿为空时跳过**，
  避免空白表单一打开就报「Cookie 未生效」。
- 刷新图标按钮与选择器共用同一层边框（不是漂在字段外的孤立控件），只重拉列表
  （host 侧 60s 缓存节流），不刷新用量；未配置且草稿为空时禁用——无可拉取对象。
- 列表拉取失败在下拉下方以行内提示呈现，不弹全局错误、不清空已选值。

11. 配置表单版式与其它设置表单一致：字段为「标签在上、控件整宽」，两个字段左缘对齐，
    标签形态复用 SubagentsSection 的 FormFieldLabel；标签与说明统一中文，不出现
    「Workspace」这类英文标签混排。
12. 首次配置与编辑已有凭据的说明分开：未配置给 Cookie 取法；已配置给
    「Cookie 留空即保留当前值，工作区留空用列表首项」。
13. 清除凭据是破坏性操作：与「保存/取消」行分开（上方有分隔线），点开走
    `AlertDialog` 二次确认后才清除。

## 接口

- `ServiceChannels.OpenCodeUsage = "opencode-usage"`；
  `IOpenCodeUsageService`（`packages/services/src/model-provider/opencodeUsageService.ts`）：
  - `getSnapshot({ providerId, refresh? })` → `OpenCodeUsageSnapshot`
  - `saveCredential({ providerId, authCookie, workspaceId })`
  - `listWorkspaces({ providerId, authCookie })` → `OpenCodeWorkspaceList`
    （`authCookie` 非空用草稿归一化后请求；为空且已配置则用已保存凭据；
    两者皆无返回空列表、error=null）
  - `clearCredential({ providerId })`
  - `getCredentialHint({ providerId })` → `{ cookieTail, workspaceId } | null`
    （cookieTail 是整段归一化后 Cookie 头的尾 4 位，仅用于判断「是否已配置」，UI 不展示）
- shared 类型：`packages/shared/src/opencode-usage.ts`
  （`OpenCodeUsageWindow`：key/status/usagePercent/usage/limit/resetInSec/resetAt；
  `OpenCodeWorkspaceOption`：id/name；`OpenCodeWorkspaceList`：workspaces/error）。
- UI 卡片视觉复用官方单卡组件 `PlanUsageMetricCard`（StatusCards.tsx，已导出）：
  窗口投影为 `UsageQuotaLimit`（`type: "OPENCODE_USAGE"`，percentage=已用占比同官方口径，
  nextResetTime 毫秒），色板与重置时间格式对齐官方 Coding Plan 卡；凭据配置表单与
  错误提示是本区块特有部分。外层 `CodingPlanUsageSummaryCards` 绑定官方重置机会/MCP
  语义，不复用。
- 判定：`isOpenCodeProviderTemplateId(templateId)`（`opencode-` 前缀，shared）。
  所有 `opencode-*` 模板卡片均提供该区块；查的是账号级 Go 套餐额度。
- Composer context 浮层入口（`ChatContextUsage` 可选 `openCodeUsage` 配置）：
  挂载条件、展示件、数据拉取时机同前版不变。
- 注册：`services/src/node.ts` 与 `desktop/src/host/remoteWorkspaceServiceCollection.ts`
  均以 `credentialService` 注入；renderer 经 `RemoteServiceAccess` getter 透明代理
  （新增方法自动可用，无需改管道）。

## 数据契约（对齐 2026-09-22 实测样本）

- `/console/api/orgs` 返回 JSON 数组 `[{id, name}, …]`；host 只保留 `id` 以 `wrk_`
  开头的条目。401/403 → `credential-stale`；其余非 2xx/网络失败 → `unavailable`。
- `/console/api/go/status` 需要 `x-org-id` 头；无该头返回
  `{"_tag":"BadRequest"}`（400）。`meters` 的 `fiveHour/week/month` 分别映射
  rolling/weekly/monthly；缺 `limit` 或 limit≤0 的窗口跳过（不得当作 0% 展示）；
  一个窗口都没有按 unavailable 上报。
- 凭据输入归一化：接受原始 token（`Fe26.2**…`）/ 单个 `auth=xxx` / 多对 `a=b; c=d` /
  完整 `Cookie:` 头，剥掉 `Cookie:` 前缀后**原样透传用户粘贴的全部 `name=value`**。
  不做 cookie 名白名单：真正管用的是 `__Host-console_session`，但按名字过滤会在
  远端改名时静默失效，原样透传最稳。裸 token 仅在形如 `Fe26.2**` 或
  `[A-Za-z0-9._-]+` 时包装成 `auth=<token>`；提取不到任何 `name=value` 且不像
  token 时归一化为空串，保存报「凭据无效」，不发出畸形请求。
- Workspace ID：正常路径来自下拉（远端返回的裸 `wrk_xxx`）；仍接受含 `wrk_…` 的
  链接文本（归一化提取）。填了内容却提不出 `wrk_…` 时保存报
  `opencode_usage_workspace_id_invalid`，不静默当成自动。**留空表示自动**——host 侧
  拉 `/console/api/orgs` 取第一个 `wrk_` 条目，按凭据缓存，后续刷新不再重复拉列表。

## 失败语义

- 401/403（console 会话失效）→ `credential-stale`：按「需重新配置」上报，保留旧快照
  不清空。
- 非 2xx（5xx 等）/ 网络失败 / 200 但没有任何可用窗口 → `unavailable`：可手动刷新。
  不展示空额度（不得静默显示 0%）。
- 未配置凭据 → `not-configured`：展示配置入口，不发请求。
- 所有失败路径在 UI 上都不得清除已展示的窗口值（last-good），错误提示与旧值并存；
  配置表单只在用户手动点「修改配置」或确认未配置时出现。

## 不变量

1. 凭据明文只存在于用户输入框、RPC 请求体与 `ICredentialService`；日志、错误消息、
   快照、persist 层一律不含 cookie 原文。
2. 请求只在 host 进程发出，renderer 不直连 opencode.ai。
3. 不改动官方 Coding Plan entitlement 链路的任何行为。
4. `IOpenCodeUsageService` 不得依赖 UI 或 provider Registry；凭据按 providerId
   隔离，删除 provider 时的凭据清理随 `clearCredential` 由 UI 触发。
5. renderer 展示投影不得持久化，不保存 Cookie/草稿、表单展开态、Workspace 列表或
   loading/saving；不通过移除详情反馈 boundary 的 provider key 来换取组件连续性。

## 迁移边界

- 不改 `zcode-builtin.json`（模板已完整）、不改 provider schema。
- 侧边栏摘要的 OpenCode 混排为后续增强，本期不做。
- 旧 seroval 解析器（`opencodeUsageParse.ts` 的 `parseOpencodeUsagePage`）随路线切换
  删除；Cookie/Workspace 归一化函数迁入服务文件，行为不变。
- 设置页表单从单文件拆成 Section + CredentialForm + 纯函数模块（见「模块划分」），
  仅版式与文案变化，数据契约与失败语义不变。

## 验收场景

1. 未配置：OpenCode 卡片显示「配置用量查询」入口，无网络请求；composer 浮层
   显示未配置提示与「配置」入口，同样不发请求。
2. 在配置表单粘贴整段 Cookie（含 `__Host-console_session`）后：下拉自动出现
   Workspace 列表（显示 name）；点下拉旁刷新按钮重新拉取；保存后卡片展示三个窗口的
   已用百分比、绝对用量与重置时间；60s 内重复打开不重复发请求。
3. Workspace 选「自动」保存：host 取列表第一个 `wrk_` 条目作为默认 Workspace 并
   按凭据缓存，后续刷新不再重复拉列表。
4. Cookie 失效（401/403）：卡片出现过期提示并引导重新配置，凭据保留，重新粘贴后恢复；
   只对 401 记「不重复请求」标记（403 下次仍重试）。
5. go/status 5xx / 网络失败 / 无任何窗口按 `unavailable` 提示，不显示 0%。
6. 全程 grep 日志与持久化文件不含 cookie 原文。
7. Composer：选中 opencode-\* provider 时输入框 context 触发器可见，展开浮层
   出现 OpenCode 三窗口 meter；切到其它 provider 后入口消失；未配置凭据时
   展开浮层只出提示，不发请求。
8. 重新打开设置页/浮层：上一次成功额度立即显示（不闪「未配置」或空白），随后
   数据过期时自动后台刷新并原位更新；刷新失败时旧值保留、仅追加错误提示，
   且不自动弹出配置表单。
9. Workspace 列表拉取失败（无效 Cookie / 网络失败）：下拉下方出现行内提示，
   不清空已选值，Cookie 草稿保留，可点刷新重试。
10. 选择器不回显整段 `wrk_`：选择「Default (wrk\_…)」后触发器只显示名称；
    列表未拉到（已保存的 Workspace 不在选项里）时显示缩短 ID，不清空选择。
11. 清除凭据必须二次确认：点「清除凭据」弹出确认框，取消则凭据与表单状态不变；
    确认后凭据清除、卡片回到未配置形态。

## 设置页导航分组

- OpenCode provider（`templateId` 以 `opencode-` 开头的 standard-personal provider）
  在模型设置侧栏拥有独立分组「OpenCode」（i18n key
  `settings.modelProvider.opencodeTitle`），位于预置分组（智谱）与
  「自定义供应商」之间，不混入自定义供应商分组。
- 分组由 `useModelProviderNavigation` 计算；组内无 provider 时整个分组隐藏。
- 分组内条目仍是普通 custom provider：详情页、排序、状态点行为不变，仅归组不同。

## 验收场景（导航分组）

12. 存在任一 opencode-\* provider 时，侧栏出现「OpenCode」分组且该 provider 不再
    出现在「自定义供应商」下；删除全部 opencode-\* provider 后分组消失。

## 添加供应商模板分组

- 添加供应商选择器（ProviderTemplatePicker）为 `opencode-*` 模板提供独立分组
  「OpenCode」（i18n key `settings.modelProvider.templateGroup.opencode`），
  位于智谱分组之后、「其他」分组之前。
- `opencode-*` 模板不再落入「其他」分组；「自定义供应商」创建入口仍保留在
  「其他」分组顶部。

## 验收场景（模板分组）

13. 打开添加供应商选择器：OpenCode 模板出现在独立「OpenCode」分组下，
    「其他」分组不再重复列出这些模板。

## 验证

- 展示投影与 Workspace 纯逻辑：`TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx
--test packages/ui/test/openCodeUsageProjectionCache.test.ts packages/ui/test/opencodeWorkspaceOptions.test.ts`
  （投影 6 项、选择器 5 项：覆盖 provider/Service 隔离、首帧 seed、generation 竞态、
  失败 last-good、not-configured/清理、Workspace 展示规则）。
- 服务层：`TSX_TSCONFIG_PATH=packages/services/tsconfig.json node --import tsx
--test packages/services/test/opencodeUsageService.test.ts`（30 项）。
- 仓库没有 React 渲染测试基建（无 vitest/playwright），表单版式、边框合并、确认弹窗
  等交互层仍需人工验收；可判定的部分被刻意抽到
  `packages/ui/src/settings/model-provider-section/opencodeWorkspaceOptions.ts` 用
  `node --test` 覆盖。
- 类型与静态检查：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check -- --changed`。

## 模块划分

- `OpenCodeUsageSection.tsx`：卡片外壳——标题行、错误提示、三窗口卡片、表单挂载与
  页面级刷新联动。
- `OpenCodeUsageCredentialForm.tsx`：凭据表单——Cookie 输入、Workspace 选择器 +
  刷新、保存/取消、清除凭据确认弹窗；草稿状态只存在于本组件，关闭即卸载。
- `opencodeWorkspaceOptions.ts`：选择器展示规则的纯函数（可测）。
- `openCodeUsageProjectionCache.ts`：按 Service 实例与 `providerId` 隔离的 renderer
  展示投影、请求 generation 和响应投影纯函数（可测，不保存凭据草稿或表单状态）。
