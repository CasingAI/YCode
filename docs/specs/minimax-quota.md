# Spec：MiniMax Token Plan 套餐额度展示（Beta）

## 背景与决策

MiniMax 在本仓库已有普通 api-key provider 模板 `minimax`
（`config/provider/zcode-builtin.json`，平台 key，打 `api.minimaxi.com/anthropic`）。
但套餐额度接口 `GET https://www.minimax.cn/v1/token_plan/remains`
（`Authorization: Bearer <API Key>`）查的是**订阅制配额**，MiniMax 官方 FAQ
（`platform.minimax.cn/docs/token-plan/faq`）明确：

- 「订阅 Key」管 plan quota + 已购积分，「普通开放平台 API Key」管按量付费余额；
- 「订阅 Key 与普通按量计费 API Key 相互独立，**不能混用**」；
- 订阅 Key 在没有席位时「暂时没有可用的付费资源」。

拿现有 `minimax` 模板的平台 key 去调 `token_plan/remains`，要么被拒要么返回空——
不是「额度为 0」而是查错了对象。因此本期**新增独立模板 `minimax-token-plan`**
（`access.type` 照旧 `api-key`，key 明文走用户个人覆盖层，模板不存 key；
管理页指 Token Plan 控制台；模型列表与 logo 复用现有 MiniMax），额度能力只挂
在这个新模板上，现有 `minimax` 平台模板不挂任何额度区块。

- 数据路线（唯一）：`GET https://api.minimaxi.com/v1/token_plan/remains`
  （与模板推理 baseUrl 同 host；写死官方 host，不跟随用户改写的代理地址，
  与 DeepSeek/OpenCode 一致），`Authorization: Bearer <该 provider 的订阅 Key>`：
  ```json
  {
    "model_remains": [
      {
        "model_name": "general",
        "current_interval_remaining_percent": 62,
        "current_weekly_remaining_percent": 81,
        "remains_time": 12345678,
        "weekly_remains_time": 234567890,
        "current_interval_status": 1,
        "current_weekly_status": 1
      }
    ]
  }
  ```
- **只信 `*_remaining_percent`（0–100），不信 `*_count`**：2026-05 之后
  `current_*_total_count` / `current_*_usage_count` 恒为 0，且 `usage_count`
  在服务端语义反复横跳（官方仓库 issue #68、#165 实证），解析层直接忽略。
- **只取 `model_name === "general"` 的编程额度桶**：数组会混入 video 等非编程模型条目。
- **`status === 3` 表示「不在套餐内」**：套餐外的模型会返回 `remaining_percent: 100`
  配 `status: 3`（官方 CLI issue #173），照直渲染会出现「无限额度」假象，
  必须判「不在套餐」而不渲染百分比。
- **`weekly_boost_permille` 上限钳制**：周额度可放大（如 1500 ⇒ 展示到 150%），
  渲染时钳到 200%（对齐官方 CLI `MAX_DISPLAY_PCT`）。
- **判定范围**：只有 `templateId === "minimax-token-plan"` 的 provider 显示额度区块。
  不做 baseUrl 匹配。
- **Beta 标记**：本能力未经真实账号验证（维护者无 MiniMax 订阅账号），模板选择器卡片
  在「已适配额度显示」之外再挂一颗「Beta」胶囊（见
  `docs/specs/provider-template-quota-tag.md`）。Beta 只出现在添加供应商选择器，
  不进入设置页卡片与 Composer 浮层。
- **产品形态与位置对齐 OpenCode/DeepSeek**：设置页 provider 卡片的 `statusSection`
  插槽，以及聊天输入框的 context 浮层。两处复用同一份 host 侧数据，不各自拉取。

## 状态所有者与数据流

```text
minimax-token-plan provider 配置里的 access.apiKey（provider 域既有事实，非本能力新增存储）
  → IMiniMaxQuotaService.getSnapshot（renderer 经 RPC 代理，host 进程执行）
  → host 进程 GET https://api.minimaxi.com/v1/token_plan/remains（Bearer <订阅 Key>）
  → JSON 归一化为 MiniMaxQuotaSnapshot（general 桶的 interval/weekly 双窗口）
  → 内存缓存 60s 节流 + last-good → 设置卡片渲染
                                    ↘ Composer context 浮层渲染
```

- API key 的唯一所有者仍是 provider 配置域。本能力**不新增持久化存储**，
  不复制 key 到 `ICredentialService`，不回显 key（连尾号都不回显）。
- 快照是派生数据：host 侧内存缓存（最近一次结果 60s TTL）+ last-good
  （最近一次成功快照，按 providerId 单独保存）+ renderer 展示投影，可随时丢弃重取。
  语义与 DeepSeek 余额服务一致。
- 请求只在 host 进程发出，renderer 不直连 api.minimaxi.com。

## 展示语义

1. 额度卡片与其它用量/余额卡片在同一插槽内互斥出现（minimax-token-plan 只出现本卡）。
2. 两个窗口：当前周期（interval，文本模型实测 5 小时，**用 `end_time - start_time`
   反推窗口长度，不硬编码**）与周（weekly）。每窗口显示剩余百分比与重置时间，
   展示件复用 `PlanUsageMetricCard` / `ChatCodingPlanUsageMeter`（只写
   「远端窗口 → `UsageQuotaLimit[]`」投影，percentage 口径为已用占比 = 100 - remaining）。
3. `status === 3` 的窗口不渲染百分比，显示「不在套餐内」。
4. 无席位订阅 Key（远端 `2062 no active token plan subscription` 类响应）按
   `unavailable` 提示，**不得当作 0% 展示**。
5. last-good 展示：只有成功快照更新窗口值；失败只更新错误提示，上一次额度保留展示。
   仅 `not-configured`（provider 已无 API key）清除展示值。
6. 首帧连续性与 stale-while-revalidate：与 DeepSeek/OpenCode 一致（展示投影 +
   60s 过期自动强刷）。
7. 刷新入口统一：模型设置页顶部的页面级「刷新」按钮（`ModelProviderRefreshSignal`），
   卡片自身不额外挂刷新按钮。
8. `not-configured` 不渲染配置表单，改为一行提示：额度查询需要先在上方「API Key」
   填写 MiniMax 订阅 Key。

## 接口

- `ServiceChannels.MiniMaxQuota = "minimax-quota"`；
  `IMiniMaxQuotaService`（`packages/services/src/model-provider/minimaxQuotaService.ts`）：
  - `getSnapshot({ providerId, refresh? })` → `MiniMaxQuotaSnapshot`
- shared 类型：`packages/shared/src/minimax-quota.ts`
  （`MiniMaxQuotaWindow`：key/remainingPercent/resetAt/status；
  `MiniMaxQuotaSnapshot`：providerId/fetchedAt/windows/error/errorMessage；
  判定 `isMiniMaxTokenPlanProviderTemplateId(templateId)`，全等 `minimax-token-plan`）。
- UI：`useMiniMaxQuota` hook + `MiniMaxQuotaSection` 卡片；
  Composer context 浮层新增 `minimaxQuota` 可选配置。
- 注册：`services/src/node.ts` 与 `desktop/src/host/remoteWorkspaceServiceCollection.ts`
  均注入 provider 配置读取依赖（复用 DeepSeek 的 resolveApiKey lambda）；
  renderer 经 `RemoteServiceAccess` getter 透明代理。

## 数据契约

- `model_remains` 缺失/非数组，或没有 `model_name === "general"` 条目，或 general 条目
  两个 percent 都缺失时按 `unavailable` 上报，**不得当作 0% 展示**。
- percent 非有限数或超出 0–100（未计 boost）时该窗口记为缺失；boost 后的周值钳到 200%。
- `remains_time` / `weekly_remains_time` 为毫秒数，换算为重置时刻；缺失时 resetAt 为 null。
- 401/403 → `credential-stale`（订阅 Key 无效/被拒）；其余非 2xx、网络失败、
  JSON 解析失败 → `unavailable`。

## 失败语义

- provider 无 API key → `not-configured`：不发请求，展示提示引导去填订阅 Key。
- 401/403 → `credential-stale`：提示密钥无效；保留旧额度不清空。
- 其余失败 → `unavailable`：可手动刷新，不展示 0%。
- 所有失败路径都不得清除已展示额度（last-good），错误提示与旧值并存。

## 不变量

1. API key 明文只存在于 provider 配置与 host 进程的本次请求头；快照、日志、错误消息、
   renderer 一律不含 key（连尾号都不回）。
2. 请求只在 host 进程发出，renderer 不直连 api.minimaxi.com。
3. 不改动官方 Coding Plan entitlement 链路、OpenCode 用量链路、DeepSeek 余额链路的任何行为。
4. `IMiniMaxQuotaService` 不依赖 UI 或 provider Registry；只按 providerId 读 key。
5. renderer 展示投影不得持久化，不保存任何凭据或表单状态。

## 迁移边界

- 新增 `minimax-token-plan` 模板（`zcode-builtin.json`）；不改 provider schema、
  不新增凭据存储键。
- 不做额度变动历史、用量明细、侧边栏摘要混排。
- 不支持非 minimax-token-plan 模板的 baseUrl 猜测式判定。
- 稳定性风险已知：2026-03 认证失效、2026-04 路径迁移、2026-06-01 字段破坏性变更、
  2026-09-28 国内域名迁移。解析层按「缺字段降级」写，UI 侧坚持 last-good 优先。

## 验收场景

1. minimax-token-plan provider 已填订阅 Key：卡片显示 5 小时与周两条剩余百分比与
   重置时间；60s 内重复打开不重复发请求。
2. 未填 API key：卡片提示需要先填写订阅 Key，不发网络请求，不显示 0%。
3. 订阅 Key 无效（401/403）：卡片出现密钥无效提示；上一次成功额度保留展示。
4. `status === 3` 的模型：显示「不在套餐内」，不渲染 100%。
5. 无席位订阅 Key（2062 类）：按「获取失败」提示，不显示 0%，旧值保留。
6. 网络失败/5xx/空 `model_remains`：按「获取失败」提示，不显示 0%，旧值保留。
7. 切走再切回、关闭再打开设置页：上次额度首帧直接可见，过期后自动后台刷新原位更新。
8. Composer：选中 minimax-token-plan provider 时输入框 context 触发器出现额度浮层；
   切到其它 provider 后入口消失。
9. 全程 grep 日志与快照不含 API key。

## 验证

- 服务层：`TSX_TSCONFIG_PATH=packages/services/tsconfig.json node --import tsx
--test packages/services/test/minimaxQuotaService.test.ts`。
- 展示纯逻辑（percent 解析、status 判定、窗口投影）用 `node --test` 覆盖。
  仓库无 React 渲染测试基建，卡片版式需人工验收。
- 静态检查：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。

## 模块划分

- `minimaxQuotaService.ts`：host 侧状态所有者——读 key、请求、归一化、节流与 last-good。
- `useMiniMaxQuota.ts`：renderer hook——加载竞态防护、展示投影、首帧恢复、刷新入口。
- `MiniMaxQuotaSection.tsx`：卡片外壳与错误/未配置提示。
- `minimaxQuotaDisplay.ts`：窗口与百分比的纯展示规则（可测）。
