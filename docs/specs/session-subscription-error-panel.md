# Spec: 会话订阅失败面板的错误分级与历史保留

## 背景与目标

CLI 重启（或常驻池回收）后打开历史子代理会话：内存注册表无、磁盘无持久化时，
CLI 侧 `ColdSessionResumeCoordinator.resume`
（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/cold-session-resume.ts`）
抛 `V4SubscribeSessionUnavailableError`，message 形如 `${detail} (${reasonCode})`，
reasonCode 两种：`fault.subscribe.sessionNotFound`（会话不存在/未持久化，
重试无意义）与 `fault.subscribe.resumeFailed`（恢复中途失败，可重试）。
renderer 侧 `ConversationProjectionStore.connect` catch 后落
`status: "error", lastError: message`（`conversationProjectionStore.ts`），
`SessionPane` 把整个 `ConversationTimeline` 替换成
`SessionSubscriptionErrorPanel`——当前该面板把原始英文错误以
`font-mono text-destructive` 居中大红整屏展示，按钮为「反馈问题」「重新连接」。

体验问题有二：

1. 大红等宽英文是给开发者看的堆栈视图，不是产品文案；且两种性质完全不同的
   失败（会话已消失 vs 瞬态断连）共用一个面板、都给「重新连接」，
   点了注定失败的按钮只会再报一次同样的错。
2. error 态整体替换 timeline：runtime 换代退避耗尽（`handleRuntimeUnavailable`，
   或断线重连失败）时 store 仍持有此前的一致 snapshot，历史明明还在，却被整块
   抹掉，用户看不到任何上下文，重建会话的入口也断了。

本 spec 定义：按 reasonCode 分级的面板展示、error 态下历史快照的只读保留、
以及断线期间 composer 与行级命令入口的关闭规则。纯 UI 行为改动，
不改 CLI 错误格式、不改 store 状态机、不改遥测钩子行为。

## 产品规则

### 错误分级

解析入口唯一：`resolveSessionSubscriptionErrorDisplay(lastError)`
（`packages/ui/src/v4/sessionSubscriptionError.ts`，UI 侧共享纯函数）。
解析对象是 store 已经写进 `lastError` 的字符串，**不改 CLI error 格式**：

- `detail (fault.subscribe.xxx)` 后缀形式（冷恢复路径的标准 message）；
- 纯 reasonCode 形式（store `failRecovery` 会把裸 `fault.subscription.*` 码
  直接写进 `lastError`，遥测侧已有同形先例）。

分流结果只有两档：

| lastError 特征 | 档位 kind | 重试按钮 | 标题（zh-CN） |
| --- | --- | --- | --- |
| 解析出 `fault.subscribe.sessionNotFound` | `sessionEnded` | **不展示** | 「该会话已结束，无法重新连接」 |
| `fault.subscribe.resumeFailed`、runtime 换代耗尽（`RUNTIME_RECYCLED_ERROR`）、其他一切（含解析失败、`fault.subscription.*` 码、传输类英文错误） | `disconnected` | 展示 | 「与代理的连接已断开」 |

- **sessionEnded 不给「重新连接」**：会话不存在/未持久化时 `subscribeConversationV4`
  只能再失败一次，按钮只会制造第二次一模一样的红屏。保留「反馈问题」。
- **disconnected 保留「重新连接」+「反馈问题」**：resumeFailed 与 runtime 换代耗尽
  都有重订阅自愈路径（start-if-needed 会拉起 runtime），值得给用户手动入口。
- 两档都不得直接把原始错误当正文展示；原始英文错误收进可展开的「查看详情」
  （沿用既有 key `chat.error.expandDetails` / `chat.error.collapseDetails`），
  展开区用 `font-mono` + 弱化色，服务诊断，不承担阅读职能。

### 历史保留

- `status === "error"` 且 store 仍有本会话 snapshot（`snapshot?.sessionId === sessionId`，
  与 `timelineSnapshot` 同一身份匹配条件）时：**先按只读方式渲染已有历史**
  （`ConversationTimeline` 正常走 `timelineSnapshot`），错误信息以紧凑横幅
  （`SessionSubscriptionErrorNotice`）展示在历史之后。
- 无 snapshot（冷会话首次订阅即失败的目标场景）才渲染完整空态面板
  （`SessionSubscriptionErrorPanel`，中性图标 + 一级标题 + 二级说明 + 操作按钮）。
- 紧凑横幅与完整面板共用同一分级解析、同一按钮可见性规则；
  横幅省略二级说明，只保留图标 + 标题 + 「查看详情」+ 两个操作按钮。
- **只读=不能发消息**：errored 期间 composer 与主要命令入口一律关闭——
  composer `disabled`、行级 fork/retry/edit/assistantFeedback 回调、
  selectionActions、goal 暂停/恢复回调不再下发。CLI facade fail-closed 前
  新建的 unknown 账本项比按钮灰掉更难解释；订阅恢复 live 后既有可用性判定
  （如 `row.actions.canRetry`）重新生效，本门禁不做语义裁决。队列面板与
  阻塞交互弹窗同 `connecting` 瞬态期的既有行为保持一致（本次不改），
  其操作仍由 CLI 侧 fail-closed 兜底。

### 样式（DESIGN.md）

- 去掉整屏 `text-destructive` 等宽英文；按 DESIGN.md「Type roles」与
  「Semantic feedback colors」重组：中性图标（`text-foreground-subtle`，
  不借用 destructive 语义色制造 louder 的块）、
  一级标题 `text-ui-base font-medium`、二级说明 `text-ui-sm text-foreground-subtle`、
  按钮走既有 `Button` 体系（outline / primary，`sm` 尺寸）。
- 字体只用 `text-ui-*` 刻度；等宽仅保留在「查看详情」展开区
  （DESIGN.md：*Use monospace only where the content is inherently technical*）。
- 紧凑横幅用 `rounded-xl border-border bg-surface` 低强调容器
  （DESIGN.md「Cards and Panels」：low-emphasis containers use `bg-surface`）。

## 状态所有者与数据流

```text
CLI V4SubscribeSessionUnavailableError(message = "detail (reasonCode)")
  → ConversationProjectionStore.connect catch → setState({ status:"error", lastError })
  → useConversationProjection(lease) 只读投影 state.status / state.lastError / state.snapshot
  → SessionPane: errored = sessionId !== null && state.status === "error"
      ├─ 有 snapshot → ConversationTimeline(只读，按 timelineSnapshot) + SessionSubscriptionErrorNotice
      └─ 无 snapshot → SessionSubscriptionErrorPanel(完整空态)
  → 分级：resolveSessionSubscriptionErrorDisplay(lastError) → { kind, retryable, reasonCode }
```

- **分级解析的唯一所有者**是 `resolveSessionSubscriptionErrorDisplay`
  （UI 纯函数）。面板、横幅、遥测之外的展示判定都不各自解析；
  CLI error 格式不动，`reasonCode` 仍以 message 后缀透传。
- **snapshot 的所有者仍是 `ConversationProjectionStore`**：本 spec 只消费
  `state.snapshot`（connect 非 forceSnapshot 路径本就保留旧 snapshot，
  `conversationProjectionStore.ts:550`），不引入第二份历史副本、不清空、
  不重建。历史渲染完全复用既有 `ConversationTimeline` 与 `timelineSnapshot`
  身份匹配（`SessionPane.tsx` 4422 附近），不新增会话事实。
- **命令入口的关闭是纯 UI 门禁**：errored 时 composer `disabled`、行级
  fork/retry/edit/assistantFeedback/selectionActions/goal 暂停恢复回调不再下发；
  store 状态机、retry() 语义、行级 actions 投影（`row.actions.canRetry` 权威）
  均不变。retry() 只被完整面板/紧凑横幅的「重新连接」按钮调用
  （`handleRetrySubscribe` → `lease.store.retry()`）。
- **遥测不变**：`useSessionSubscriptionErrorTelemetry`（`SessionPane.tsx`
  4404 附近）的 `visible` 仍为 `errored && telemetryVisible && foreground`——
  紧凑横幅同样属于可见错误面，曝光语义保持原样；其自身的 `fault.*` 码解析
  面（telemetry 聚合用，覆盖全部 fault 码）与本 spec 的展示分级
  （只判 `fault.subscribe.*` 两档）职责不同，互不复用、互不影响。

## 接口与不变量

- 新增 `packages/ui/src/v4/sessionSubscriptionError.ts`（UI 侧共享纯函数，
  无 IO、无 React 依赖）：
  - `type SessionSubscriptionErrorKind = "sessionEnded" | "disconnected"`；
  - `interface SessionSubscriptionErrorDisplay { kind; retryable: boolean; reasonCode: string | null }`；
  - `resolveSessionSubscriptionErrorDisplay(lastError: string | null): SessionSubscriptionErrorDisplay`；
  - `parseSessionSubscriptionReasonCode(lastError: string | null): string | null`
    （`(fault.subscribe.xxx)` 后缀或整串裸码；只认 `fault.subscribe.` 前缀，
    `fault.subscription.*` 等其他 fault 码原样返回但不参与分级歧义）。
- `packages/ui/shared` 新增两个 testid（`packages/shared/src/test-ids.ts`）：
  `TID_V4_SUBSCRIPTION_ERROR_PANEL`（面板/横幅根节点，e2e 锚点）、
  `TID_V4_SUBSCRIPTION_ERROR_DETAILS`（「查看详情」开关）。
  `TID_V4_RETRY_SUBSCRIBE` 保持原位（仅 disconnected 档渲染）。
- `packages/ui/src/v4/SessionSubscriptionErrorPanel.tsx`：
  - 默认导出形态为完整空态（无 snapshot 场景）；props 不变
    （`error / sessionId / workspacePath / onReconnect`）。
  - 新增导出 `SessionSubscriptionErrorNotice`（紧凑横幅，同 props），
    与完整面板共用内部分级与反馈草稿构造，不复制第二份解析。
  - 反馈草稿（`buildErrorFeedbackDescription`）沿用既有实现，
    title 取人话标题而非原始英文截断（前 80 字符规则不变）。
- `SessionPane.tsx`：
  - `errored` 定义不变（`sessionId !== null && state.status === "error"`）；
  - 新增派生 `erroredWithHistory = errored && timelineSnapshot !== null`，
    注意 `timelineSnapshot` 的身份匹配条件（`snapshot?.sessionId === sessionId`）；
  - 渲染分支：`errored && !timelineSnapshot` → 完整面板；
    否则既渲染 timeline（errored 时只读），errored 时在 timeline 之后附紧凑横幅；
  - composer `disabled` 与行级命令入口纳入 `errored` 门禁
    （`readOnly` 已把子代理观察视图的 composer 整段掐掉，两者语义叠加不冲突）；
  - `useSessionSubscriptionErrorTelemetry` 调用点与参数不变。

## 依赖方向与边界

- 改动全部落在 `packages/ui/src/v4`、`packages/ui/src/i18n/locales`、
  `packages/shared/src/test-ids.ts`；`ui` 模块为 legacy（`managed: false`），
  无跨模块新边（共享纯函数在 ui 内，testid 走既有 `@zcode/shared` 公开入口）。
- 不改 `apps/zcode-cli` 任何代码：`V4SubscribeSessionUnavailableError` 的
  message 格式、reasonCode 取值不变；UI 侧兼容解析。
- 不改 `conversationProjectionStore.ts`：error 写入点、runtime 换代有界退避、
  retry() 语义原样。
- i18n key 中英文两份同步新增：
  `chat.error.sessionEnded.title` / `chat.error.sessionEnded.description` /
  `chat.error.connectionLost.title`（复用 `chat.error.connectionLost` 既有中文
  文案作为标题，英文补 `chat.error.connectionLost.title`）/
  `chat.error.connectionLost.description`；
  详情开关复用 `chat.error.expandDetails` / `chat.error.collapseDetails`。

## 负面边界（不做什么）

- 不做错误自动消失/自动重试；所有重试仍是用户显式点击（store 既有的
  runtime 换代有界退避不受影响，那是 connecting 态的自愈，不落 error）。
- 不把「重新连接」改成条件置灰隐藏之外的花样（如只读占位），
  sessionEnded 档直接不渲染。
- 不在紧凑横幅里二级说明，避免历史之后被大段文字挤占；也不把横幅做成
  可关闭 toast（它必须常驻，直到订阅恢复）。
- 不引入新的 store 字段、协议字段或 CLI reasonCode。
- 不为子代理只读面板（`readOnly`）之外的调用方改变行级交互默认值：
  errored 期间统一关闭，恢复 live 后既有可用性判定重新生效。

## 验收场景

单测（`packages/ui/test/`，沿用仓库既有两种形态：SSR 渲染 + 源码断言）：

1. 分级解析（`sessionSubscriptionError.test.ts`）：
   - `"...: xxx (fault.subscribe.sessionNotFound)"` → `sessionEnded`，`retryable: false`；
   - `"... (fault.subscribe.resumeFailed)"` → `disconnected`，`retryable: true`；
   - 裸码 `fault.subscription.recoveryFrameTimedOut` → `disconnected`；
   - 无码英文错误（如 transport closed）、`null` → `disconnected`；
   - `fault.subscribe.sessionNotFound` 出现在正文中段（非后缀）不误判。
2. 面板渲染（SSR，`sessionSubscriptionErrorPanel.test.ts`）：
   - sessionNotFound 档：无 `data-testid` = `TID_V4_RETRY_SUBSCRIBE` 的按钮，
     有「反馈问题」与「查看详情」开关，根节点挂 `TID_V4_SUBSCRIPTION_ERROR_PANEL`，
     含人话标题，**不含**整屏 `text-destructive` 等宽英文正文；
   - resumeFailed 档：重新连接按钮存在且挂 `TID_V4_RETRY_SUBSCRIBE`；
   - 两档的标题/按钮差异只来自分级函数同一输出。
3. SessionPane 接线（源码断言，`sessionSubscriptionErrorHistory.test.ts`）：
   - `errored` 定义与 `timelineSnapshot` 身份匹配未被破坏；
   - 存在 `erroredWithHistory`（或等价）派生并用于渲染分支；
   - 历史保留分支仍渲染 `ConversationTimeline` 且 `rows` 取 `timelineSnapshot`；
   - 紧凑横幅组件被引用且在 timeline 之后；
   - composer `disabled` 条件包含 errored（断线不可提交）。
4. 中英文 locale 键齐全（源码断言）：新键在 zh-CN 与 en-US 同时存在。

运行 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`
均无新增违规；`packages/ui` 既有测试全绿。
