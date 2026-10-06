# Spec: 移除 Coding Plan 付费引导能力

## 目标

YCode 对所有模型供应商一视同仁，App 自身不承担任何付费引导职责。此前 Coding Plan 保留了完整的「升级 / 购买」链路：7 个付费入口把用户导向内嵌官网 webview 完成支付，服务端保留 Stripe / PayPal / 企业订单的下单实现。

本次把这三层全部移除：付费入口、内嵌官网 webview 转发壳、服务端下单能力。套餐状态查询、额度展示、登录鉴权与闲时资格判定不受影响 —— 这些是 YCode 作为 Coding Plan 客户端的正常功能，与付费无关。

## 产品规则

### 不再有付费引导

- YCode 内任何界面都不出现「升级」「续期」「订阅」「购买」「管理订阅」等引导用户付费的入口，包括未购买态和已购买态。
- 已购买用户不再有续费或管理订阅的引导外链。用户若要变更或续订，自行前往供应商官网。
- 会话中不再出现额度耗尽横幅。额度信息仍在设置页使用统计、侧栏套餐徽标与输入框余额浮层展示。额度耗尽时的准入控制（阻断发送、抑制错误横幅）保持不变，只是不再主动弹出提示。
- 模型未配置时的错误横幅只保留「设置模型」操作，不再提供升级按钮。
- 闲时任务资格不足时 toast 只做告知；仅当资格查询失败时，toast 的 action 为「重试」。

### 保留的能力

- 套餐状态查询与权益展示：设置页套餐状态卡的连接状态、套餐等级、额度、重置时间、已购套餐的续期日期。
- 侧边栏 footer 的套餐徽标与头像菜单里的「使用统计」入口。
- 输入框余额浮层的额度数字。
- OAuth 登录、解绑、重登录、断线重试、凭据存储与权益轮询。
- 企业（团队）套餐的定价与余额只读查询 —— 服务于状态展示，不含下单。
- 团队静态套餐目录与 Start Plan 权益预览（`getStaticTeamProducts`、`getStartPlanPreview`）。
- 闲时任务的资格判定、灰度与额度展示。
- 账号连接丢失后的套餐切换建议（`useAccountConnectionLossNotification`）。其中 `purchaseBanner.startPlanTitle` 与 `purchase.individualsSectionTitle` 两个 key 仍在使用 —— 它们被当作套餐名标签，不是付费引导文案。

### 供应商一视同仁

不存在「因为是智谱所以给购买入口」的特殊处理。任何未来接入的新供应商都不因供应商身份获得付费引导能力；额度展示能力按是否对接额度查询系统判定，与 `website-docs-site.md` 的官方支持标准一致。

## 被移除的入口清单

| 原入口                             | 位置                                              |
| ---------------------------------- | ------------------------------------------------- |
| 侧栏头像菜单「升级 / 续期」        | `WorkspaceSidebarFooterUsageSummary.tsx`          |
| 套餐卡「升级 / 续期」              | `StatusCards.tsx` + `CodingPlanStatusActions.tsx` |
| 套餐卡「订阅」（未购买态）         | `StatusCards.tsx`                                 |
| 套餐卡「管理订阅」外链             | `StatusCards.tsx`                                 |
| 「体验 / 个人 / 团队套餐」带价横幅 | `Detail.tsx`                                      |
| 会话额度横幅及升级胶囊             | `ConversationQuotaBanner.tsx`                     |
| 输入框余额浮层的升级项             | `StartPlanContextBalance.tsx`                     |
| 错误横幅的升级按钮                 | `ChatErrorBanner.tsx`                             |
| 闲时任务 toast 的升级 action       | `AutomationsSection.tsx`                          |

## 被移除的能力层

- **弹窗壳**：`CodingPlanUpgradeDialog`、`CodingPlanUpgradeDialogProvider`、`CodingPlanEmbeddedWebviewDialog`、`codingPlanEmbeddedWebview`、`codingPlanUpgradeLoginRecovery`、`codingPlanPurchaseAuth`、`CodingPlanEntryButton`、`useCodingPlanEntryPlanList`、`codingPlanEntryInventoryState`、`codingPlanOwnedEntryPlans`、`codingPlanFunnelTelemetry`、`sidebarCodingPlanUpgrade`。
- **desktop webview 桥**：`preload/codingPlanWebview.ts`、主进程的 webview 源判定与导航拦截（含只为 Coding Plan 存在的 `will-navigate` 守卫）、`clearCodingPlanWebviewStorage` 命令、`VITE_CODING_PLAN_WEBVIEW_ORIGIN` 注入。
- **shared 契约**：webview 通道与 payload、`isTrustedCodingPlanWebviewOrigin`、`DesktopCommandIds.ClearCodingPlanWebviewStorage`、续费外链 `teamCodingPlanManageUrl` 与 `buildBigModelCodingPlanPersonalManageUrl` / `buildBigModelCodingPlanTeamManageUrl`、`coding-plan-subscription.ts` 的支付 / 签约 / 订单类型。
- **services 下单**：`ICodingPlanSubscriptionService` 的 18 个下单与支付方法、`batchPreview` 与 `getStaticProducts`（个人静态套餐目录的唯一消费方是购买弹窗）。
- **UI 套餐查询**：`useCodingPlanProducts`、`codingPlanEnterpriseTiers`、`resolveCodingPlanUpgradeProductsProviderId`；`normalizeErrorMessage` 迁到 `codingPlanProductPresentation.ts` 供企业套餐与 Start Plan 查询复用。

## 状态所有者与事件顺序

本规则不引入任何新状态。删除付费链路后，套餐状态与额度的所有者不变：

```
额度 / 套餐状态
  → useCodingPlanEntitlements / useEnterpriseCodingPlanProducts（只读查询）
    → 侧栏徽标 / 设置页套餐卡 / 使用统计 / 输入框余额浮层
```

闲时任务资格的刷新路径不变，只是失败时的重试来源从购买入口门禁改为闲时资格查询本身：

```
闲时资格查询失败
  → toast action「重试」
    → useOffPeakTaskStore.refreshCodingPlanSupport（重新查资格）
```

## 负面边界

- 不删除或改写套餐状态查询、企业定价与余额只读查询、OAuth 与凭据相关代码。
- 不改动闲时任务的资格判定、灰度与调度。
- 不删除会话额度准入：`useV4SessionQuotaBanner` 的 `blocksSubmit` 与 `takesOverError` 继续生效，只剥离升级字段与第二次 entitlement 请求。
- 不改动普通内嵌浏览器 webview 的 preload 与导航守卫 —— `preload/embeddedBrowserJavaScriptDialog` 与已删除的 Coding Plan 专用 preload 是两套。
- 不改动 `CODING_PLAN_SYSTEM_BUSY`、`ForceUpdateConfig` 等服务端下发配置。
- 不改动额度数据本身的采集与口径，只是不再在会话中主动提示。
- 不改用「auth」刷新原因替代手动重置额度后的强制失效刷新（`refreshReason: "purchase"` 的缓存失效语义保留，仅为内部原因标签）。
- 不新增第二套状态、RPC 或服务方法。

## 验收场景

1. 工作区侧栏头像菜单：语言 / 主题 / 界面模式 / 缩放 / 使用统计 之后直接是登录或登出，无「升级」项；设置页复用同一菜单，同样没有。
2. 设置页模型供应商分区：已购套餐卡显示状态、套餐等级、额度与续期时间，有「解绑」，无「升级」「续期」「管理订阅」任何按钮；未购买态不再出现「订阅」按钮和三条带价横幅，只剩连接与登录操作。
3. 会话中额度耗尽：不再出现额度横幅；输入框余额浮层仍显示剩余额度，无「升级」项；模型未配置时错误横幅只剩「设置模型」。
4. 闲时任务：资格不足时 toast 文案说明需要 Coding Plan 资格；资格查询失败时 toast 的 action 是「重试」，点击后重新查询资格。
5. 全仓 `openCodingPlanUpgrade`、`CodingPlanEntryButton`、`purchase_funnel`、`coding_plan_upgrade_ck`、`codingPlanWebview` 零命中。
6. 设置页模型供应商分区与使用统计正常加载额度；解绑 Coding Plan provider 后状态刷新；侧栏 footer 徽标仍正确显示套餐；闲时任务资格判定与创建不受影响。
7. 额度耗尽时会话仍不能提交消息，错误横幅仍被额度态抑制 —— 删的是提示，不是准入。
