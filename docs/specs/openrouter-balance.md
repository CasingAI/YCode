# Spec：OpenRouter 账户余额展示（Beta）

## 背景与决策

OpenRouter 在本仓库是普通 api-key provider（`config/provider/zcode-builtin.json` 的
`openrouter` 模板）。它**只有预付积分（pay-as-you-go）一种计费形态**，没有订阅制套餐
（官方 FAQ 明说是 credit system + 手动/自动充值；Free / Business / Enterprise 是功能
权益分层，不是订阅额度包）。因此它的「用量」就是账户积分余额，与 DeepSeek 同一口径。

- 数据路线（唯一）：`GET https://openrouter.ai/api/v1/credits`，
  `Authorization: Bearer <该 provider 的 API key>`：
  ```json
  {
    "data": {
      "total_credits": 100.5,
      "total_usage": 25.75
    }
  }
  ```
  **没有直接的余额字段，剩余额度 = `total_credits - total_usage`**（USD，美元金额，
  不是 token）。单币种，无多币种列表。
- **没有订阅周期口径**：没有 5 小时/周滚动窗口。`GET /api/v1/key` 虽有
  `usage_daily/weekly/monthly` + `limit_remaining`，但那是单 key 追踪且窗口为
  UTC 日/周/月、`limit_remaining` 在未设上限时为 null，本次不用——本期只做账户余额。
- **受限风险已知**：当前官方文档把 `/api/v1/credits` 标注为 management key required，
  普通推理 key 可能 403。实现时 403 按 `credential-stale` 上报（与 DeepSeek 一致），
  不为此分支做特殊处理；若实测普通 key 普遍 403，后续再议是否改调 `/api/v1/key`。
- **没有独立凭据**：查询用的就是 provider 自身已配置的 API key，不需要 OpenCode 那套
  Cookie 表单。401/403 即 key 无效，没有 Workspace 选择、没有窗口/重置时间。
- **判定范围**：只有 `templateId === "openrouter"` 的 provider 显示余额区块。
  不做 baseUrl 匹配。
- **Beta 标记**：本能力未经真实账号验证（维护者无 OpenRouter 付费账号），模板选择器卡片
  在「已适配额度显示」之外再挂一颗「Beta」胶囊（见
  `docs/specs/provider-template-quota-tag.md`）。Beta 只出现在添加供应商选择器，
  不进入设置页卡片与 Composer 浮层。
- **产品形态与位置对齐 DeepSeek**：设置页 provider 卡片的 `statusSection` 插槽，
  以及聊天输入框的 context 浮层。两处复用同一份 host 侧数据，不各自拉取。

## 状态所有者与数据流

```text
OpenRouter provider 配置里的 access.apiKey（provider 域既有事实，非本能力新增存储）
  → IOpenRouterBalanceService.getSnapshot（renderer 经 RPC 代理，host 进程执行）
  → host 进程 GET https://openrouter.ai/api/v1/credits（Bearer <key>）
  → JSON 归一化为 OpenRouterBalanceSnapshot（remaining = total_credits - total_usage）
  → 内存缓存 60s 节流 + last-good → 设置卡片渲染
                                    ↘ Composer context 浮层渲染
```

- API key 的唯一所有者仍是 provider 配置域。本能力**不新增持久化存储**，
  不复制 key 到 `ICredentialService`，不回显 key（连尾号都不回显）。
- 快照是派生数据：host 侧内存缓存（最近一次结果 60s TTL）+ last-good
  （最近一次成功快照，按 providerId 单独保存）+ renderer 展示投影，可随时丢弃重取。
  语义与 DeepSeek 余额服务一致。
- 请求只在 host 进程发出，renderer 不直连 openrouter.ai。

## 展示语义

1. 余额卡片与其它用量/余额卡片在同一插槽内互斥出现（openrouter 只出现本卡）。
2. 单行展示：USD 剩余额度（总额减已用），版式复用 DeepSeek 两行币种+金额
   （上行 `USD`，下行 `Intl.NumberFormat(locale, { style: "currency", currency: "USD" })`，
   中文界面 `$74.75` 类形态）。**不画进度条、不展示百分比**：无总额口径的比例没有意义；
   总额与已用作为次要信息可在金额下方小字列出（可选，缺失时不渲染）。
3. 负值如实展示（余额可能为小额负数），不截为 0，不隐藏。
4. last-good 展示：只有成功快照更新金额；失败只更新错误提示，上一次金额保留展示。
   仅 `not-configured`（provider 已无 API key）清除展示值。
5. 首帧连续性与 stale-while-revalidate：与 DeepSeek 一致（展示投影 +
   60s 过期自动强刷）。
6. 刷新入口统一：模型设置页顶部的页面级「刷新」按钮（`ModelProviderRefreshSignal`），
   卡片自身不额外挂刷新按钮。
7. `not-configured` 不渲染配置表单，改为一行提示：余额查询需要先在上方「API Key」
   填写 OpenRouter 密钥。

## 接口

- `ServiceChannels.OpenRouterBalance = "openrouter-balance"`；
  `IOpenRouterBalanceService`
  （`packages/services/src/model-provider/openrouterBalanceService.ts`）：
  - `getSnapshot({ providerId, refresh? })` → `OpenRouterBalanceSnapshot`
- shared 类型：`packages/shared/src/openrouter-balance.ts`
  （`OpenRouterBalanceSnapshot`：providerId/fetchedAt/totalCredits/totalUsage/
  remaining/error/errorMessage；
  判定 `isOpenRouterProviderTemplateId(templateId)`，全等 `openrouter`）。
- UI：`useOpenRouterBalance` hook + `OpenRouterBalanceSection` 卡片；
  Composer context 浮层新增 `openRouterBalance` 可选配置。
- 注册：`services/src/node.ts` 与 `desktop/src/host/remoteWorkspaceServiceCollection.ts`
  均注入 provider 配置读取依赖（复用 DeepSeek 的 resolveApiKey lambda）；
  renderer 经 `RemoteServiceAccess` getter 透明代理。

## 数据契约

- `data.total_credits` / `data.total_usage` 缺失或非有限数时按 `unavailable` 上报，
  **不得当作 0 展示**。金额可能是数字也可能是十进制字符串，两者都接受。
- `remaining = total_credits - total_usage` 由 host 侧计算后写入快照，
  renderer 不做算术（避免浮点口径分叉）。
- 401/403 → `credential-stale`（API key 无效/被拒，含普通 key 被 management 门槛拒绝）；
  其余非 2xx、网络失败、JSON 解析失败 → `unavailable`。

## 失败语义

- provider 无 API key → `not-configured`：不发请求，展示提示引导去填 key。
- 401/403 → `credential-stale`：提示密钥无效；保留旧金额不清空。
- 其余失败 → `unavailable`：可手动刷新，不展示 0。
- 所有失败路径都不得清除已展示金额（last-good），错误提示与旧值并存。

## 不变量

1. API key 明文只存在于 provider 配置与 host 进程的本次请求头；快照、日志、错误消息、
   renderer 一律不含 key（连尾号都不回）。
2. 请求只在 host 进程发出，renderer 不直连 openrouter.ai。
3. 不改动官方 Coding Plan entitlement 链路、OpenCode 用量链路、DeepSeek 余额链路、
   MiniMax 额度链路的任何行为。
4. `IOpenRouterBalanceService` 不依赖 UI 或 provider Registry；只按 providerId 读 key。
5. renderer 展示投影不得持久化，不保存任何凭据或表单状态。

## 迁移边界

- 不改 `zcode-builtin.json`（`openrouter` 模板已存在）、不改 provider schema、
  不新增凭据存储键。
- 不做余额变动历史、日/周/月用量追踪（`/api/v1/key` 字段）、侧边栏摘要混排。
- 不支持非 openrouter 模板的 baseUrl 猜测式判定。

## 验收场景

1. OpenRouter provider 已填 API key：卡片显示 USD 剩余额度一行（总额减已用）；
   60s 内重复打开不重复发请求。
2. 未填 API key：卡片提示需要先填写 API Key，不发网络请求，不显示 0。
3. API key 无效（401/403，含普通 key 被 management 门槛拒绝）：卡片出现密钥无效提示；
   上一次成功余额保留展示。
4. 余额为负或 0：金额如实显示，不截断、不隐藏。
5. 网络失败/5xx/响应缺字段：按「获取失败」提示，不显示 0，旧值保留。
6. 切走再切回、关闭再打开设置页：上次余额首帧直接可见，过期后自动后台刷新原位更新。
7. Composer：选中 openrouter provider 时输入框 context 触发器出现余额浮层；
   切到其它 provider 后入口消失。
8. 全程 grep 日志与快照不含 API key。

## 验证

- 服务层：`TSX_TSCONFIG_PATH=packages/services/tsconfig.json node --import tsx
--test packages/services/test/openrouterBalanceService.test.ts`。
- 展示纯逻辑（相减口径、USD 格式化、缺失项过滤）用 `node --test` 覆盖。
  仓库无 React 渲染测试基建，卡片版式需人工验收。
- 静态检查：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。

## 模块划分

- `openrouterBalanceService.ts`：host 侧状态所有者——读 key、请求、归一化、节流与 last-good。
- `useOpenRouterBalance.ts`：renderer hook——加载竞态防护、展示投影、首帧恢复、刷新入口。
- `OpenRouterBalanceSection.tsx`：卡片外壳与错误/未配置提示。
- `openrouterBalanceDisplay.ts`：金额的纯展示规则（可测）。
