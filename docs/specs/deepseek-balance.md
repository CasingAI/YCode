# Spec：DeepSeek 官方余额展示

## 背景与决策

DeepSeek 在本仓库是普通 api-key provider（`config/provider/zcode-builtin.json` 的
`deepseek` 模板）。它不是订阅套餐，没有「剩余额度/重置时间」这类周期用量口径，
**它的用量就是 DeepSeek 开放平台的账户余额**。本期在 OpenCode 套餐用量能力之后，
为 DeepSeek 提供同形态的余额展示：

- 数据路线（唯一）：`GET https://api.deepseek.com/user/balance`，
  `Authorization: Bearer <该 provider 的 API key>`：
  ```json
  {
    "is_available": true,
    "balance_infos": [
      {
        "currency": "CNY",
        "total_balance": "110.00",
        "granted_balance": "10.00",
        "topped_up_balance": "100.00"
      }
    ]
  }
  ```
  三个金额字段都是**字符串**，币种为 `CNY` 或 `USD`；一个账号可能同时返回两种币种。
- **没有独立凭据**：查询用的就是 provider 自身已配置的 API key（`config.access.apiKey`），
  因此不需要 OpenCode 那套「粘贴 Cookie + 保存凭据表单」。也没有配额标记
  （401/403 即 key 无效）、没有 Workspace 选择、没有窗口/重置时间。
- **判定范围**：只有 `templateId === "deepseek"` 的 provider 显示余额区块。
  不做 baseUrl 匹配——手动填 DeepSeek 地址的自定义 provider 可能走代理或第三方网关，
  其 key 在官方余额接口上大概率无效，展示「获取失败」反而是噪声。
- **产品形态与位置对齐 OpenCode**：设置页 provider 卡片的 `statusSection` 插槽，
  以及聊天输入框的 context 浮层。两处复用同一份 host 侧数据，不各自拉取。

## 状态所有者与数据流

```text
DeepSeek provider 配置里的 access.apiKey（provider 域既有事实，非本能力新增存储）
  → IDeepSeekBalanceService.getSnapshot（renderer 经 RPC 代理，host 进程执行）
  → host 进程 GET https://api.deepseek.com/user/balance（Bearer <key>）
  → JSON 归一化为 DeepSeekBalanceSnapshot（金额按十进制字符串解析成 number，币种保留原文）
  → 内存缓存 60s 节流 + last-good → 设置卡片渲染
                                    ↘ Composer context 浮层渲染
```

- API key 的唯一所有者仍是 provider 配置域（`config.access.apiKey`）。本能力
  **不新增持久化存储**，不复制 key 到 `ICredentialService`，不回显 key（连尾号都不回显：
  DeepSeek key 无「需重新配置」的独立入口，key 就在上方 provider 表单里）。
- 快照是派生数据：host 侧内存缓存（最近一次结果 60s TTL，用于请求节流）+ last-good
  （最近一次成功快照，按 providerId 单独保存）+ renderer 展示投影，可随时丢弃重取。
  语义与 `docs/specs/opencode-usage-quota.md` 的 OpenCode 服务一致，便于对齐维护。
- 请求只在 host 进程发出，renderer 不直连 api.deepseek.com。

## 展示语义

1. 余额卡片与 OpenCode 用量卡片在同一插槽内互斥出现（DeepSeek provider 只出现余额卡）。
2. 每个币种展示两行——上行币种代码、下行 `total_balance` 金额，金额由
   `Intl.NumberFormat(locale, { style: "currency" })` 格式化，**自带货币符号**
   （中文界面 `¥19.54`，英文界面无歧义的 `CN¥19.54`）：符号与千分位跟随界面语言，
   消歧义交给 CLDR，不自己拼裸 `$`。深色/浅色主题与官方用量卡共用同一套货币口径。
   远端币种不是合法 ISO 4217 形态时（如 `US`、中文）回退到「代码 + 数字」，不让异常
   崩掉整张卡；金额缺失时不出数字（不当作 0）。
   **不画进度条、不展示百分比、不展示 `granted_balance` / `topped_up_balance` 明细**：
   DeepSeek 不给总额，进度条的「剩余/总量」算不出来，硬画一个比例就是编造；余额构成是
   有用但不必要的信息。多币种时全部列出，主币种排在首位（CNY 优先，其余按远端顺序）。
3. `is_available === false` 时给出「余额不足，无法调用 API」的提示，仍展示余额数字
   （余额可能是小额负数或极低值，不隐藏）。
4. last-good 展示：只有成功快照更新金额；失败只更新错误提示，上一次金额保留展示。
   仅 `not-configured`（provider 已无 API key）清除展示值。
5. 首帧连续性：详情子树因选中供应商重挂载时，renderer 通过按
   `IService 实例 + providerId` 隔离的展示投影同步恢复余额首帧，命中后仍向 host
   校验新鲜度。`fetchedAt` 超过 60s 时自动强刷一次（stale-while-revalidate）。
6. 刷新入口统一：模型设置页顶部的页面级「刷新」按钮刷新余额（走
   `ModelProviderRefreshSignal`，与官方 Coding Plan 卡片、OpenCode 用量卡片一致）。
   卡片自身不额外挂刷新按钮。
7. `not-configured` 不渲染配置表单（无独立凭据），改为一行提示：余额查询需要先在
   上方「API Key」填写 DeepSeek 密钥。

## 接口

- `ServiceChannels.DeepSeekBalance = "deepseek-balance"`；
  `IDeepSeekBalanceService`（`packages/services/src/model-provider/deepseekBalanceService.ts`）：
  - `getSnapshot({ providerId, refresh? })` → `DeepSeekBalanceSnapshot`
- shared 类型：`packages/shared/src/deepseek-balance.ts`
  （`DeepSeekBalanceInfo`：currency/totalBalance/grantedBalance/toppedUpBalance；
  `DeepSeekBalanceSnapshot`：providerId/fetchedAt/isAvailable/balances/error/errorMessage；
  判定 `isDeepSeekProviderTemplateId(templateId)`）。
- 判定：`isDeepSeekProviderTemplateId(templateId)`（`deepseek` 全等，shared）。
- UI：`useDeepSeekBalance` hook + `DeepSeekBalanceSection` 卡片；
  Composer context 浮层新增 `deepSeekBalance` 可选配置。
- 注册：`services/src/node.ts` 与 `desktop/src/host/remoteWorkspaceServiceCollection.ts`
  均注入 provider 配置读取依赖；renderer 经 `RemoteServiceAccess` getter 透明代理。

## 数据契约

- 响应体 `balance_infos` 缺失或为空数组时按 `unavailable` 上报，**不得当作 0 元展示**。
- 金额为十进制字符串，用 `Number(...)` 解析；解析结果非有限数（`NaN`/`Infinity`）时该字段
  记为 `null`，全币种都解析不出来按 `unavailable` 上报。原始字符串不进日志。
- `currency` 保留远端原文（`CNY`/`USD`），展示端本地化符号；未知币种按原文展示。
- 401/403 → `credential-stale`（API key 无效/被拒）；其余非 2xx、网络失败、
  JSON 解析失败 → `unavailable`。

## 失败语义

- provider 无 API key → `not-configured`：不发请求，展示提示引导去填 key。
- 401/403 → `credential-stale`：提示密钥无效；保留旧金额不清空。
- 其余失败 → `unavailable`：可手动刷新，不展示 0 元。
- 所有失败路径都不得清除已展示金额（last-good），错误提示与旧值并存。

## 不变量

1. API key 明文只存在于 provider 配置与 host 进程的本次请求头；快照、日志、错误消息、
   renderer 一律不含 key（连尾号都不回）。
2. 请求只在 host 进程发出，renderer 不直连 api.deepseek.com。
3. 不改动官方 Coding Plan entitlement 链路与 OpenCode 用量链路的任何行为。
4. `IDeepSeekBalanceService` 不依赖 UI 或 provider Registry；只按 providerId 读 key。
5. renderer 展示投影不得持久化，不保存任何凭据或表单状态。

## 迁移边界

- 不改 `zcode-builtin.json`（`deepseek` 模板已存在）、不改 provider schema、
  不新增凭据存储键。
- 不做余额变动历史、用量明细（DeepSeek 官方无此接口）、侧边栏摘要混排。
- 不支持非 deepseek 模板的 baseUrl 猜测式判定（见「背景与决策」）。

## 验收场景

1. DeepSeek provider 已填 API key：卡片按币种显示「币种 + 金额」两行，无进度条、无明细；
   60s 内重复打开不重复发请求。
2. 未填 API key：卡片提示「需要先填写 API Key」，不发网络请求，不显示 0 元。
3. API key 无效（401/403）：卡片出现密钥无效提示；上一次成功余额保留展示。
4. 余额为 0 或 `is_available=false`：金额如实显示为 0，并给出「余额不足」提示。
5. 网络失败/5xx/空 `balance_infos`：按「获取失败」提示，不显示 0 元，旧值保留。
6. 切走再切回 DeepSeek provider、关闭再打开设置页：上次余额首帧直接可见，
   过期后自动后台刷新原位更新。
7. Composer：选中 deepseek provider 时输入框 context 触发器出现余额浮层；
   切到其它 provider 后入口消失。
8. 全程 grep 日志与快照不含 API key。

## 验证

- 服务层：`TSX_TSCONFIG_PATH=packages/services/tsconfig.json node --import tsx
--test packages/services/test/deepseekBalanceService.test.ts`。
- 展示纯逻辑（金额格式化、币种排序、缺失项过滤）：
  `packages/ui/src/settings/model-provider-section/deepseekBalanceDisplay.ts` 用
  `node --test` 覆盖。仓库无 React 渲染测试基建，卡片版式需人工验收。
- 静态检查：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。

## 模块划分

- `deepseekBalanceService.ts`：host 侧状态所有者——读 key、请求、归一化、节流与 last-good。
- `useDeepSeekBalance.ts`：renderer hook——加载竞态防护、展示投影、首帧恢复、刷新入口。
- `DeepSeekBalanceSection.tsx`：卡片外壳与错误/未配置提示。
- `deepseekBalanceDisplay.ts`：金额与币种的纯展示规则（可测）。
