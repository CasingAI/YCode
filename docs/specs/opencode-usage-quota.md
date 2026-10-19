# Spec：OpenCode Go 套餐额度（API Key）与 Zen 余额（Console Cookie）

## 背景与决策

OpenCode 在仓库中是普通 API Key provider（`config/provider/zcode-builtin.json` 中的 `opencode-*` 模板）。其中 Go（`opencode-go-*`，推理地址为 `https://opencode.ai/zen/go/v1`）是订阅制套餐，Zen（`opencode-zen-*`，推理地址为 `https://opencode.ai/zen/v1`）是按量付费：**Go 显示三窗口套餐用量，Zen 显示账户余额**。

- Go 套餐用量使用 `GET https://opencode.ai/zen/go/v1/usage`，以该 provider 已配置的 API Key 发送 `Authorization: Bearer <apiKey>`。不需要 Cookie、Workspace ID 或新增凭据输入框。
- Go API 响应只提供 `usage.rolling`、`usage.weekly`、`usage.monthly` 的 `status`、`percent` 与 `resetsAt`。`percent` 是已用百分比；API 不提供可验证的美元已用金额或额度上限，因此 `usage`、`limit` 保持 `null`，UI 不展示美元金额行，不得根据旧版固定额度推算金额。
- `percent` 为 0 时上游可能给出占位 `resetsAt`，此时不展示重置时间。只解析 `status` 为 `"ok"` 或 `"rate-limited"` 且百分比为有限数字的窗口；响应没有可用窗口时按 `unavailable` 处理，不能静默显示 0%。
- Zen 余额仍使用 Console `GET /console/api/billing/status`，认证为 Zen 自己的 Console Cookie + `x-org-id`。`GET /console/api/orgs` 与 Workspace 下拉只为 Zen 余额配置服务，不能再用于 Go 套餐额度。
- Go 只认 `opencode-go-` 前缀（`isOpenCodeGoProviderTemplateId`）；Zen 只认 `opencode-zen-` 前缀（`isOpenCodeZenProviderTemplateId`）。宽泛的 `isOpenCodeProviderTemplateId`（`opencode-` 前缀）只用于侧栏分组与图标共用。
- OpenCode 用量是 provider 域的独立能力，不进入官方 Z.AI/BigModel Coding Plan entitlement 链路，不在侧边栏套餐摘要混排。展示位置是设置页 Go provider 卡片，以及聊天输入框 context 浮层。

## 状态所有者与数据流

### Go 套餐额度

```text
provider 已配置的 API Key
  → Host resolveApiKey(providerId)（只读，不复制、不落盘）
  → GET /zen/go/v1/usage，Authorization: Bearer <apiKey>
  → usage.rolling / weekly / monthly 映射为三窗口百分比与重置时间
  → Host 内存缓存（60s TTL + last-good）
  → OpenCodeUsageSnapshot → 设置卡片与 Composer context 浮层
```

Go API Key 由本地 Host 或远程工作区 Host 从各自的 provider 配置中读取。密钥不回传 renderer、不写入 `ICredentialService`、不进入日志或快照。网络请求只在 Host 进程发出，renderer 通过 RPC 调用服务。

### Zen 余额

```text
用户粘贴 Zen Console Cookie，选择 Workspace
  → saveCredential / listWorkspaces
  → ICredentialService（host 加密 KV，key: opencode-usage:<providerId>）
  → GET /console/api/billing/status（Cookie + x-org-id）
  → 解析余额 → Host 缓存 → Zen 余额卡片
```

Zen Cookie 与 Workspace 的唯一持久化所有者仍是 Host 的 `ICredentialService`。不写入 `provider_config.json`、不进日志、renderer 不持久化。Go 额度查询不读取这份凭据。

### 缓存与并发

- Host 侧缓存最近一次结果（60s TTL，用于请求节流）与 last-good（最近一次成功快照，按 providerId 隔离）。失败保留 last-good 并附带错误；Go provider 未配置 API Key 时清除旧额度值并返回 `not-configured`。
- renderer 展示投影按 `IOpenCodeUsageService` 实例和 `providerId` 隔离，只缓存 last-good、错误类别与脱敏 hint；不保存 API Key、Cookie 原文、表单草稿、Workspace 列表或 loading/saving 状态。
- Go 额度 Hook 只请求额度快照，不调用 Cookie/Workspace 凭据接口。Zen 余额区块使用 credentials-only 模式读取 Cookie hint、列 Workspace、保存或清除凭据，不触发 Go 额度查询。
- `getSnapshot(refresh: false)` 在缓存过期但有 last-good 时立即返回旧值并触发后台刷新；同 provider 的后台刷新去重。只有最新 generation 的请求可提交展示投影，避免 provider 切换后旧请求覆盖新状态。

## 展示语义

1. Go 卡片自动使用 provider 已配置的 API Key 查询额度，不再提供 Cookie 输入框、Workspace 选择器、凭据保存/清除入口，也不再展示相关提示。
2. 保留 5 小时（rolling）、每周（weekly）、每月（monthly）三张卡片。`percentage` 传入已用占比，由 `PlanUsageMetricCard` 负责显示剩余百分比；根据 `resetsAt` 显示重置时间。
3. Go 接口不提供金额，美元「剩余金额 / 总额」行不渲染。不得复用旧 Console meters 的 `$12/$30/$60` 上限，也不得按百分比推测美元数值。
4. Go 错误语义：没有 provider API Key → `not-configured`；HTTP 401 → API Key 被拒绝；HTTP 403 → 接口未找到该 API Key 对应的可用 Go 用量记录（也可能是服务端关联异常，不一定代表订阅未开通）；其它非 2xx、网络失败或没有可用窗口 → `unavailable`。失败时保留 last-good，未配置 API Key 时清除旧额度值。
5. 页面级刷新按钮刷新 Go 用量（走 `ModelProviderRefreshSignal`）；卡片不提供单独的刷新按钮。
6. Zen 余额卡片继续使用独立的 Cookie + Workspace 表单。Cookie 草稿防抖 600ms 后可自动拉 Workspace 列表；列表首项可作为默认 Workspace；Cookie 留空表示沿用已保存凭据；清除凭据需二次确认。表单的错误文案必须明确它用于 Zen 余额，不再暗示 Go 额度也需要 Cookie。
7. Zen 余额无窗口、百分比或重置时间；金额优先解析 `balanceMicroCents`，缺失时回退 `availableMicroCents`，微美分按 1 美元 = 1e8 微美分换算。`"0"` 是合法余额，必须展示 `$0`；字段缺失且无法解析时按 `unavailable` 处理，不得把缺失当 0。

## 接口与模块

- `ServiceChannels.OpenCodeUsage = "opencode-usage"`；`IOpenCodeUsageService` 位于 `packages/services/src/model-provider/opencodeUsageService.ts`：
  - `getSnapshot({ providerId, refresh? })`：Go 用量，复用 provider API Key。
  - `getZenBalance({ providerId, refresh? })`：Zen 余额，使用 Cookie + Workspace。
  - `saveCredential`、`listWorkspaces`、`clearCredential`、`getCredentialHint`：只供 Zen Cookie/Workspace 配置使用。
- `packages/services/src/model-provider/opencodeConsoleApi.ts`：Go `/zen/go/v1/usage` Bearer 请求、响应解析，以及 Zen Console 请求/余额解析。
- `packages/services/src/model-provider/opencodeUsageRoutes.ts`：Go 与 Zen 两条独立路由。
- `packages/shared/src/opencode-usage.ts`：共享快照、窗口、凭据和错误类型。
- `packages/ui/src/settings/model-provider-section/OpenCodeUsageSection.tsx`：Go 三窗口卡片，无 Cookie 表单。
- `OpenCodeUsageCredentialForm.tsx` 与 `opencodeWorkspaceOptions.ts`：只用于 Zen 余额的 Cookie/Workspace 配置。
- `OpenCodeZenBalanceSection.tsx`：Zen 余额卡片，凭据 Hook 使用 `credentialsOnly` 模式。
- `openCodeUsageProjectionCache.ts` 与 `useOpenCodeUsage.ts`：共享快照投影与刷新生命周期。
- `services/src/node.ts` 与 `desktop/src/host/remoteWorkspaceServiceCollection.ts` 都注入 provider API Key 读取函数；本地和远程 Host 均不将密钥暴露给 renderer。

## 数据契约

### Go usage

`GET /zen/go/v1/usage` 请求头只有必要的 `Authorization: Bearer <apiKey>`、`Accept: application/json` 与 User-Agent；不发送 Cookie 或 `x-org-id`。

响应形状：

```json
{
  "usage": {
    "rolling": { "status": "ok", "percent": 28, "resetsAt": "2026-10-19T20:00:00.000Z" },
    "weekly": { "status": "ok", "percent": 25, "resetsAt": "2026-10-26T00:00:00.000Z" },
    "monthly": { "status": "ok", "percent": 29, "resetsAt": "2026-11-01T00:00:00.000Z" }
  }
}
```

示例仅说明字段结构，不代表真实额度或固定重置时间。`rolling → rolling`、`weekly → weekly`、`monthly → monthly`；`percent` 限制到 0–100。`usage` 和 `limit` 保持 `null`，因为接口不返回绝对金额。401 → `credential-stale`；403 → `subscription-required`（无可用套餐用量记录，也可能是服务端关联异常）；其它非 2xx、网络失败、JSON 错误或无有效窗口 → `unavailable`。

### Zen Console

- `/console/api/orgs` 返回 `[{id, name}, …]`；Host 只保留 `id` 以 `wrk_` 开头的条目。此列表仅供 Zen 余额表单。
- Zen 余额：`GET /console/api/billing/status`，使用 Zen 自己的 Cookie + `x-org-id`。实测 prepaid/pay-as-you-go 响应包括 `balanceMicroCents`、`availableMicroCents` 等微美分字符串。优先 `balanceMicroCents`，缺失时回退 `availableMicroCents`；除以 1e8 换算美元。401/403 → `credential-stale`，其它失败 → `unavailable`；失败保留 last-good，仅 `not-configured` 清展示值。
- Cookie 输入归一化仅用于 Zen：接受原始 token、单个 `auth=xxx`、多对 `a=b; c=d` 或完整 `Cookie:` 头；剥掉 `Cookie:` 前缀后原样透传用户粘贴的 `name=value`。Workspace ID 来自 `wrk_` 下拉项；留空表示 Host 取 Workspace 列表首项。无效 Cookie 或无效 Workspace 不发送畸形请求。

## 不变量

1. Go API Key 只从 provider 配置读取，不进入本服务凭据存储、renderer 状态、日志或快照。
2. Zen Cookie 明文只存在于用户输入、RPC 请求体与 `ICredentialService`；日志、错误消息、快照、persist 层一律不含 Cookie 原文。
3. 请求只在 Host 进程发出，renderer 不直连 opencode.ai。
4. 不改动官方 Coding Plan entitlement 链路的任何行为。
5. provider 数据按 `providerId` 隔离；删除 provider 时 Zen 凭据清理沿用 `clearCredential`。
6. renderer 展示投影不得持久化，不保存 API Key、Cookie/草稿、表单展开态、Workspace 列表或请求 Promise。

## 验收场景

1. 已配置 Go provider API Key：打开 Go provider 卡片自动显示三窗口百分比和重置时间；网络请求使用 Bearer API Key，不发送 Cookie、`x-org-id` 或额外的 Workspace 请求。
2. Go provider 没有 API Key：不发网络请求，显示明确的 API Key 配置提示；不出现 Cookie/Workspace 表单。
3. Go API 返回 401 时提示 API Key 被拒绝；返回 403 时提示接口未找到该 Key 对应的可用 Go 用量记录，并说明可能存在服务端关联问题；5xx、网络失败或无有效窗口时提示获取失败且不显示假 0%。
4. Go API 只返回百分比时，三张卡片不显示美元绝对金额；`percent=0` 时忽略占位重置时间。
5. 刷新期间旧值保留；缓存过期后自动后台刷新；连续请求去重，provider 切换后旧响应不能覆盖新状态。
6. Zen provider 仍可粘贴 Cookie、拉取/选择 Workspace、保存、修改与清除凭据；该组件不会触发 Go usage API 请求。
7. Zen 余额 `$0` 必须正常展示；Cookie 失效时提示重新配置，列表拉取失败时保留已选值与草稿。
8. 日志和持久化数据不包含 API Key 或 Cookie 原文；Go API Key 不被复制到专用凭据存储。
9. OpenCode 模板仍在独立「OpenCode」分组；Go 模板挂载三窗口卡片，Zen 模板挂载余额卡片。

## 验证

- Go/Zen 服务测试：`pnpm exec tsx --test packages/services/test/opencodeUsageService.test.ts`
- 展示投影与 Workspace 纯逻辑：`TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/openCodeUsageProjectionCache.test.ts packages/ui/test/opencodeWorkspaceOptions.test.ts`
- Zen 余额货币格式：`TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/openrouterAndZenBalanceDisplay.test.ts`
- 类型与静态检查：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check -- --changed`。
- 设置页 UI 与远程 Host 实际请求仍需在应用内手动验收；测试应确认 Go 路由没有 Cookie/Workspace 请求头。
