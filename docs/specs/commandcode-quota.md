# Spec：Command Code 套餐供应商与额度展示

## 背景与决策

Command Code（CommandCode.ai，终端 AI 编程智能体 + 订阅套餐服务）是与 MiniMax Token Plan、
OpenCode Go 同类的**套餐制供应商**：订阅套餐（Go/GOAT/Pro/Max）按月给美元额度，按
5 小时滚动窗口 + 7 天滚动窗口限速，模型覆盖 DeepSeek/GLM/Kimi/MiniMax/Qwen/Claude/GPT
等 50+（完整清单 `https://api.commandcode.ai/provider/v1/models`，模型 id 前缀可选、
大小写不敏感）。本期新增**供应商模板 `commandcode`**（添加入口）并挂**套餐额度显示**。

- 模板：`templateId === "commandcode"`，显示名「Command Code」（中英文同）。
  推理协议 `openai-chat-completions`，baseUrl `https://api.commandcode.ai/provider/v1`
  （官方 Provider API，同时提供 `/chat/completions`、`/responses`、`/messages` 三协议，
  本模板取 OpenAI Chat Completions）。接入类型 `api-key`，key 在
  `https://commandcode.ai/settings/keys` 签发，CLI 与 API 同 key，不区分订阅 Key/平台 Key
  （与 MiniMax 双 key 体系不同，不需要独立订阅模板）。
- 数据路线（唯一）：`GET https://api.commandcode.ai/alpha/billing/credits`
  （`Authorization: Bearer <该 provider 的 API Key>`），单次调用同时返回
  **余额**与**窗口额度**：
  ```json
  {
    "credits": { "monthlyCredits": 71.2, "purchasedCredits": 0, "freeCredits": 0 },
    "windowLimits": {
      "fiveHour": { "used": 6.4, "cap": 20, "exceeded": false, "resetAt": 1793272800000 },
      "weekly":   { "used": 18.5, "cap": 50, "exceeded": false, "resetAt": 1793704800000 }
    }
  }
  ```
  契约来源：官方 CLI（`command-code@1.82.1`）实际调用顺序与社区接入实证
  （DSH `dsh-commandcode-provider`，真实账号四接口全通），**官方文档未公开该端点**，
  因此按「未经真实账号端到端验证」的风险处理：last-good + 错误降级兜底，不挂 Beta。
- **只信 `/alpha/*`（CLI key 鉴权），不碰 `/internal/*`**：官网用量明细三条
  （`/internal/usage*`）只认浏览器登录会话 Cookie，同一账号的 API key 实测 401
  （社区实证 2026-10-14），不接入。
- **余额字段区分「未上报」与 0**：`credits.*Credits` 缺失 ≠ 0；缺失的币种记 null，
  展示端不渲染，绝不出现假 0（对齐 DSH `monthlyReported` 语义教训）。
- **窗口是美元计价**：`used/cap` 为金额（美元），百分比 = used/cap×100（钳 0–100）。
  `cap <= 0` 或缺失表示该窗口无上限/未上报——**该窗口不渲染**（缺窗口 ≠ 0% 用满）。
  `exceeded === true` 表示已触顶，展示端标注「已用尽，等待重置」。
- 判定范围：只有 `templateId === "commandcode"` 的 provider 显示额度区块。
  不做 baseUrl 匹配。
- **去 Beta（2026-10-28）**：模板卡片保留「已适配额度显示」但不再挂「Beta」胶囊
  （已从 `supportsTemplateBetaTag` 白名单移除，见
  `docs/specs/provider-template-quota-tag.md`）。额度端点无官方文档背书的风险由
  last-good + 错误降级兜底，不出现假 0%/假用满。
- 产品形态与位置对齐 MiniMax/OpenCode：设置页 provider 卡片的 `statusSection` 插槽 +
  聊天输入框 context 浮层，两处复用同一份 host 侧数据。

## 状态所有者与数据流

```text
commandcode provider 配置里的 access.apiKey（provider 域既有事实，非本能力新增存储）
  → ICommandCodeQuotaService.getSnapshot（renderer 经 RPC 代理，host 进程执行）
  → host 进程 GET https://api.commandcode.ai/alpha/billing/credits（Bearer <API Key>）
  → JSON 归一化为 CommandCodeQuotaSnapshot（five-hour/weekly 双窗口 + 余额三项）
  → 内存缓存 60s 节流 + last-good → 设置卡片渲染
                                ↘ Composer context 浮层渲染
```

- API key 的唯一所有者仍是 provider 配置域。本能力**不新增持久化存储**，不复制 key
  到 `ICredentialService`，不回显 key（连尾号都不回显）。
- 快照是派生数据：host 侧内存缓存（最近一次结果 60s TTL）+ last-good（最近一次成功
  快照，按 providerId 单独保存）+ renderer 展示投影，可随时丢弃重取。
  语义与 MiniMax/DeepSeek 服务一致。
- 请求只在 host 进程发出，renderer 不直连 api.commandcode.ai。

## 展示语义

1. 额度卡片与其它用量/余额卡片在同一插槽内互斥出现（commandcode 只出现本卡）。
2. 两个窗口卡片：5 小时窗口（five-hour）与 7 天窗口（weekly），每窗口显示
   **已用百分比**（used/cap）与重置时间；展示件复用 `PlanUsageMetricCard` /
   `ChatCodingPlanUsageMeter`。`detail` 行显示「已用 $X / 上限 $Y」（金额两位小数，
   0 显示 $0）。
3. `exceeded === true` 的窗口不渲染进度条，显示「已用尽，等待重置」。
4. 余额行：卡片窗口下方一行「套餐余额 $X」（monthly + purchased + free 三项之和，
   只加已上报项；三项全部未上报时不渲染该行）。
5. last-good 展示：只有成功快照更新窗口值；失败只更新错误提示，上一次额度保留展示。
   `not-configured`（provider 已无 API key）清除展示值，但保留错误状态（同 MiniMax）。
6. 首帧连续性与 stale-while-revalidate：与 MiniMax/DeepSeek 一致（展示投影 +
   60s 过期自动强刷）。
7. 刷新入口统一：模型设置页顶部页面级「刷新」按钮（`ModelProviderRefreshSignal`），
   卡片自身不挂刷新按钮；查询在途时顶部刷新按钮进入 Loading 态。
8. `not-configured` 渲染一行提示：先在上方「API Key」填写 Command Code 的 API Key。
9. 配置变更后自动重查：provider 配置 revision 变化后 1s 防抖重查一次，
   `refresh=true` 绕开 host 侧节流（同 MiniMax）。
10. 任何「没有额度值」的状态都要有对应文案（未配置 / 查询失败 / 查询中），
    不允许只有标题的空白卡片。

## 接口

- `ServiceChannels.CommandCodeQuota = "commandcode-quota"`；
  `ICommandCodeQuotaService`（`packages/services/src/model-provider/commandCodeQuotaService.ts`）：
  - `getSnapshot({ providerId, refresh? })` → `CommandCodeQuotaSnapshot`
- shared 类型：`packages/shared/src/commandcode-quota.ts`
  （`CommandCodeQuotaWindow`：key/used/cap/usagePercent/exceeded/resetAt；
  `CommandCodeQuotaCredits`：monthly/purchased/free，null = 未上报；
  `CommandCodeQuotaSnapshot`：providerId/fetchedAt/windows/credits/error/errorMessage；
  判定 `isCommandCodeProviderTemplateId(templateId)`，全等 `commandcode`）。
- UI：`useCommandCodeQuota` hook + `CommandCodeQuotaSection` 卡片；
  Composer context 浮层新增 `commandCodeQuota` 可选配置。
- 注册：`services/src/node.ts` 与 `desktop/src/host/remoteWorkspaceServiceCollection.ts`
  均注入 provider 配置读取依赖（复用 MiniMax 的 resolveApiKey lambda 写法）；
  renderer 经 `RemoteServiceAccess` getter 透明代理。

## 数据契约

- `credits.windowLimits` 缺失/非对象，或五个字段任一非法（used/cap 非有限非负数）时
  该窗口记缺失；两个窗口都缺失时整体按 `unavailable` 上报，**不得当作 0% 展示**。
- `cap <= 0`（官方语义为无上限）的窗口不渲染：解析层保留该窗口但 `cap` 为 0 时
  `usagePercent` 记 null，展示端跳过；实现取「cap 非法或 ≤0 ⇒ 窗口缺失」，spec 与
  实现一致。
- `resetAt` 为毫秒时间戳，换算为 ISO；缺失/非法时 resetAt 为 null（不阻塞窗口展示）。
- `credits` 对象缺失/非对象时三项余额全部记 null（不渲染余额行，不算错误）。
- 401/403 → `credential-stale`（key 无效/被拒）；其余非 2xx、网络失败、JSON 解析失败
  → `unavailable`。

## 失败语义

- provider 无 API key → `not-configured`：不发请求，展示提示引导去填 key。
- 401/403 → `credential-stale`：提示密钥无效；保留旧额度不清空。
- 其余失败 → `unavailable`：可手动刷新，不展示 0%。
- renderer → host 的 RPC 调用本身失败（传输异常）：同样按 `unavailable` 提示；
  旧额度按 last-good 保留。
- 所有失败路径都不得清除已展示额度（last-good），错误提示与旧值并存。

## 不变量

1. API key 明文只存在于 provider 配置与 host 进程的本次请求头；快照、日志、错误消息、
   renderer 一律不含 key。
2. 请求只在 host 进程发出，renderer 不直连 api.commandcode.ai。
3. 不改动 MiniMax/OpenCode/DeepSeek/OpenRouter/智谱/CLI Proxy 各额度链路的任何行为。
4. `ICommandCodeQuotaService` 不依赖 UI 或 provider Registry；只按 providerId 读 key。
5. renderer 展示投影不得持久化，不保存任何凭据或表单状态。
6. 模型 id 照官方原样存储（前缀可选、大小写不敏感是官方匹配规则），YCode 不做改写。

## 迁移边界

- 新增 `commandcode` 模板（`zcode-builtin.json`，排 openrouter 之后）；
  不改 provider schema、不新增凭据存储键。
- 不做用量明细（逐请求/逐模型/每日曲线）、不做多账号轮换、不做充值入口。
- 不支持非 commandcode 模板的 baseUrl 猜测式判定。
- 已知稳定性风险：`/alpha/*` 为官方 CLI 内部接口，无文档兼容承诺，路径或字段
  可能随官方版本漂移；解析层按「缺字段降级」写，UI 侧坚持 last-good 优先。

## 验收场景

1. 「添加供应商」出现 Command Code 卡片（普通供应商分组，挂「已适配额度显示」，
   不挂「Beta」）；点击创建后 detail 表单无连接区改动（普通表单），
   baseUrl/api 类型为模板默认值。
2. commandcode provider 已填 API Key：卡片显示 5 小时与 7 天两条已用百分比、
   金额明细与重置时间，及「套餐余额」行；60s 内重复打开不重复发请求。
3. 未填 API key：卡片提示需要先填写，不发网络请求，不显示 0%。
4. key 无效（401/403）：卡片出现密钥无效提示；上一次成功额度保留展示。
5. 网络失败/5xx/响应无窗口：按「获取失败」提示，不显示 0%，旧值保留。
6. `exceeded === true` 窗口：显示「已用尽，等待重置」，不渲染进度条。
7. `credits` 缺失但窗口正常：只显示窗口，不渲染余额行，不报错。
8. 切走再切回、关闭再打开设置页：上次额度首帧直接可见，过期后自动后台刷新原位更新。
9. Composer：选中 commandcode provider 时输入框 context 触发器出现额度浮层；
   切到其它 provider 后入口消失。
10. 全程 grep 日志与快照不含 API key。
11. 卡片挂载时还没有 API Key：显示「请先填写 API Key」；填入并保存后 1s 内自动重查。
12. 查询在途：卡片显示「正在查询」，顶部刷新按钮同步 Loading；结束后恢复。

## 验证

- 服务层：`node --import tsx --test packages/services/test/commandCodeQuotaService.test.ts`
  （以包内既有 minimax 服务测试的同款运行方式为准）。
- 展示纯逻辑（窗口解析、百分比投影、余额求和）用 `node --test` 覆盖。
  仓库无 React 渲染测试基建，卡片版式需人工验收。
- 静态检查：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
- 真实账号端到端验证（登录 + 额度数值与官网一致）仍未执行：维护者无账号；
  风险按「last-good + 错误降级」兜底，不阻塞本期去 Beta。

## 模块划分

- `commandCodeQuotaService.ts`：host 侧状态所有者——读 key、请求、归一化、节流与
  last-good。
- `useCommandCodeQuota.ts`：renderer hook——加载竞态防护、展示投影、首帧恢复、刷新入口。
- `commandCodeQuotaProjectionCache.ts`：详情重挂载的首帧连续性投影（可丢弃）。
- `CommandCodeQuotaSection.tsx`：卡片外壳与错误/未配置/查询中提示。
- `commandCodeQuotaDisplay.ts`：窗口与百分比的纯展示规则（可测）。
- `CommandCodeContextUsage.tsx`：Composer 浮层额度段（复用官方 meter 展示件）。
