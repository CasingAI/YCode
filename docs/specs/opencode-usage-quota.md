# OpenCode Go 用量与 Zen 余额

## 目标与认证规则

- OpenCode Go 订阅额度：`GET https://opencode.ai/zen/go/v1/usage`。
- OpenCode Zen 账户余额：`GET https://opencode.ai/console/api/billing/status`。
- **两条路线都使用该 Provider 已配置的 API Key，以 `Authorization: Bearer <apiKey>` 认证。整个 OpenCode 用量/余额功能不需要 Cookie、Workspace ID、`x-org-id` 或单独的凭据表单。**
- Go 接口只返回 rolling、weekly、monthly 百分比和重置时间；不根据历史固定额度推算金额。
- Zen 余额读取 `balanceMicroCents`（微美分，`1 USD = 100,000,000`），`availableMicroCents` 只作为余额字段缺失时的兼容回退，不能优先替代真实余额。
- 以上两条路线的 Bearer 请求都通过已有 `hostApiNetworkTransport.fetch` 发出，遵循全局代理、`NO_PROXY` 和自定义 CA 设置；本地与远程 Workspace Host 都必须遵循同一约束。

## 数据流与状态所有权

```text
Provider Registry / Provider Settings View
  → Host 按 providerId 读取 access.apiKey
  → IOpenCodeUsageService.getSnapshot / getZenBalance
  → Bearer 请求 Go usage 或 Console billing/status
  → 解析为共享快照
  → 设置页状态卡片与 Composer context 浮层
```

- API Key 只在 Host 侧读取并用于请求，不复制到独立的用量凭据存储，不返回 Renderer，不进入日志或快照。
- Go 与 Zen 分别维护自己的 API Key 摘要、身份 revision、last-good 与 60 秒快照缓存。观察到 API Key 变化或移除时，立即清空该 provider 的旧缓存；旧 Key 的晚到响应不能回写，也不能让 UI 继续展示另一个账号的余额/额度。
- 过期且已有成功值时使用 stale-while-revalidate：先显示旧值并后台刷新；同一 provider 的后台请求去重。
- 首次用量查询时清理旧版本保存的 `opencode-usage:<providerId>` Cookie 记录。新代码不读取、不保存、不发送 Cookie，也不提供 Workspace 列表、Cookie hint 或旧凭据修改/清除接口。
- Renderer 的展示投影仅用于子树重挂载时保持首帧连续性，不持久化。投影按 Service 实例与 providerId 隔离，并按 credential revision 防止换 Key 后残留旧账号数据。

## 界面行为

- Go Provider 卡片显示 rolling、weekly、monthly 三个额度窗口；API Key 在标准 Provider 连接设置中维护。没有 Key 时显示明确提示，不出现额外凭据表单。
- Zen Provider 卡片显示账户余额；API Key 同样在标准 Provider 连接设置中维护。没有 Key 时提示先配置 API Key，不出现 Cookie 或 Workspace 控件。
- 保存 Provider API Key 后，Provider 设置 revision 变化会触发相应额度/余额刷新。
- Composer 中的 Go 用量和 Zen 余额共用 Host 快照与 Renderer 投影，不另建认证或缓存来源。
- `401/403` 映射为凭据/权限错误；网络、非 2xx、非法 JSON 或没有可解析数值映射为 unavailable，不能伪装成零额度/零余额。失败时同一 Key 的 last-good 可继续显示并附带错误；换 Key 后不能沿用旧账号 last-good。

## API 与类型边界

- `IOpenCodeUsageService` 只公开 `getSnapshot` 与 `getZenBalance`。
- `opencodeConsoleApi.ts` 负责两个 Bearer HTTP 请求和纯解析函数；不得引入 Cookie、Workspace 或浏览器会话依赖。
- `opencodeUsageRoutes.ts` 负责 HTTP 状态、JSON 解析与快照映射。
- `opencodeUsageService.ts` 拥有 Host 侧 API Key 身份、缓存、并发去重与旧凭据清理。
- `OpenCodeUsageSnapshot` 和 `OpenCodeZenBalanceSnapshot` 不携带 API Key、Cookie、Workspace ID 或其他凭据。

## 验收

1. Go API Key 能返回三个可用窗口；请求仅包含 Bearer Authorization，不发送 Cookie 或 `x-org-id`。
2. Zen API Key 能通过 `GET /console/api/billing/status` 取得真实余额；请求仅包含 Bearer Authorization，不发送 Cookie 或 `x-org-id`。
3. 没有 API Key 时不发送请求，并清除旧账号展示值。
4. 更换/删除 API Key 后，缓存与 UI 投影不能继续显示旧账号额度；旧请求不能覆盖新结果。
5. 401/403、5xx、非法 JSON 和缺失余额字段都有明确错误语义；真实余额为零时仍显示零，而不是 unavailable。
6. 旧版 Cookie 凭据在迁移后被清理，且代码、UI、RPC 契约不再提供 Cookie/Workspace 配置能力。
7. 服务测试、UI 投影测试、全仓类型检查、架构检查、Lint 与格式检查通过。
