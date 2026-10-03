# 会话错误横幅“继续”按钮

> 状态： Campeonato 进行中。本文先落背景与根因（防上下文压缩丢失证据链），改法待执行。

## 1. 背景：用户要什么

网络请求失败或服务器原因（限流 429、上游 5xx、断网）时，错误横幅（输入框上方 `ChatErrorBanner`）
上直接有一个“继续”按钮，不用手动复制重发。效果要求：

- 像网络失败自动重试一样：同一个任务接着跑；
- 上面显示的工作时间连续在一起；
- 重试操作不往当前上下文插入任何新消息。

## 2. 根因（已确认，可复查）

### 2.1 自动重试与横幅继续隔着轮的生死

自动重试是轮内的（`apps/zcode-cli/packages/adapters/src/model/runner-stream.ts:123-131`
的 `for (attempt...)` 循环重发同一请求；`apps/zcode-cli/packages/core/src/runtime/methods/streaming-recovery.ts`
core 恢复，429/超时/5xx 最多 10 次 `:14`，Start 忙 2 次 `:98-99`，
恢复前丢弃部分输出 `:260-264`，经 `recoverFromModelFailure → return "continue"`
（`turn-model-step.ts:279-290`）回到同一轮）。

轮一死就全断：`turn.ts:779-829` 失败即关轮抛错；TurnMachine 只有 Error→Idle
（`core/src/agent/turn-state.ts:230-260`，无 resume）；`turnId` 不可复用
（`turn.ts:114`）；转录落带 error 无正文的消息
（`turn-model-step.ts:407-429`，取消才写流快照 `:372-395`）；投影为 failed turnHeader
加 `control.lastError` 单槽（`bootstrap/.../product-projection.ts:2624-2689`；
assistantText 行只在首流帧创建 `:2945-2959`）。

`lastError` 类型见 `packages/shared/src/zcode-protocol-v4/snapshot.ts:107-119`
（code/message/recoverable/at/source/traceId/detail/attribution）。
清零只在下一轮 TurnStarted（`product-projection.ts:2457`）或 goal-verify 重启
（`:5337`）；rewind 不清（`onRewindTriggered :2137-2159` 只返回 `row.removed`）。

### 2.2 判定表原文（`streaming-recovery.ts:24-40`，继续按钮照抄）

```ts
const TRANSIENT_ERROR_CODES = new Set([
  "model_request_timeout",
  "model_rate_limited",
  "model_server_error",
  "model_network_error",
  "MODEL_REQUEST_TIMEOUT",
  "MODEL_RATE_LIMITED",
  "MODEL_SERVER_ERROR",
  "MODEL_NETWORK_ERROR",
]);
const TRANSIENT_ERROR_REASONS = new Set([
  "stream_idle_timeout",
  "rate_limited",
  "server_error",
  "network_error",
  "timeout",
]);
```

另认 `retryable===true`、ModelStreamIdleTimeoutError、timeout/ECONNRESET/EPIPE/ETIMEDOUT
文本（`:297-312`）。

### 2.3 旧“继续”为什么错（已回退 8 处，工作区干净）

旧方案复用 `retryTurn`（`fork-edit-retry.ts:246-272`）：rewind 整轮删再重发，
另起 turnId、另起计时、另插 user 消息——与“接着跑”完全相反。

模型选择另有一错：`switchModelConfig` 广播的 `nextModelSelection`
在用户没显式选档位时不带 options（`model-config.ts:49-55 createModelSelection`，
`:119-125` 组装）；`setModel` 字符串入口存会话时丢 options
（`session-facade.ts:466-472` 仅非字符串才复制 options）；显示靠
`effectiveReasoningLevel` 兜底看起来正常（`product-projection.ts:4921-4922`），
执行侧 `modelFactory` 只认选择里的 `reasoningLevel`，缺即
`reasoning-level-missing`（`packages/provider/src/registry.ts:129-159`）。
Composer 正常发送自带完整三字段（`composerSubmissionConfig.ts:28-38`），
retry 冻结 intent 原样搬运无重校验（经 `input-intent.ts:88`）。
发送前 `ensureModelReady` 当前空实现（`workspace-model-runtime.ts:114-122`），拦不住。

### 2.4 出事会话实证（`sess_35d7d2d7`）

落盘 `runtime/model_selection` 与全部真实问答消息均为 opencode 系，
零 bigmodel 使用痕迹；报错 `Provider Registry 中不存在 Provider:
account:bigmodel-individual-coding-plan` 的唯一抛出点是
`provider-registry-selection.ts:124-128` 的 provider-not-found 分支，
证明某次瞬态建模请求装了该 ID（未落盘），不是用户选过。

### 2.5 上一版（内存挂起表）为什么失败（2026-10-02 实证回退）

上一版在 core 加了内存挂起表（`suspendedTurns` Map + claim/TTL/预算），点继续时
认领内存记录。三个断点，全部实证：

1. **重启丢内存**：`lastError` 持久化、横幅跨重启还在，挂起表没了 → claim 恒
   `not_found`（`sess_36575f21` 的 22 小时前限流错误横幅，点继续零反应；
   当日日志 `turn.suspended` 0 次、info 级落盘正常）。
2. **ID 空间分叉**：冷恢复失败轮投影 id 为 `hydrate-turn-N`/持久 messageId
   （`transcript-hydration.ts:1772`、`event-normalizer.ts:231`），core 挂起表键为
   runtime turnId（`turn_*`），必然对不上。
3. **拒绝静默**：claim 失败 handler 抛错，UI 只 `logger.warn`，无用户可见反馈。

本质：挂起表是失败轮事实的重复副本，违反「避免重复状态和多条写入路径」。
失败轮的原文本来就持久化在转录里（投影 TurnStarted 时把权威 intent 原文注册进
`editTargetByEntityId`，冷恢复同样注册，`product-projection.ts:2414/:4082`），
不需要任何内存中间态。

## 3. 第一版：无状态恢复 + 新轮重发（已被 §4 取代，勿照此实现）

这一版解决的是「重启后内存挂起表丢失 → 点继续没反应」：不建内存中间态，按失败轮 id
从持久转录找回原文，**重发一个新轮**。被 §4 取代的原因：它满足「横幅有按钮」「点完能跑」，
但不满足 §1 的另外两条硬要求 —— 新轮意味着新 turnId，模型上下文里会多出一条重发正文，
也就是「以用户身份发了一条消息」，且模型能感知到任务被重新发起过。

从这一版继承进 §4 的只有一条结论：**失败轮原文的所有者是持久转录**（既有事实，
不是内存挂起表那份副本）。§3 的其余产物已全部退役并从代码里删除，不要再找：

| 已退役 | 退役原因 |
| --- | --- |
| core 内存挂起表（`SuspendedTurnRecord` / `suspendedTurns` / `claimSuspendedTurnForResume`） | 重启即丢 |
| `intent.resumedFrom` 失败轮链 | §4 没有新轮，就没有轮链；保留会留下第二条写入路径 |
| `settleResumedFromTurn`（失败轮翻 completedInterrupted） | 同上，失败轮由自己的 `TurnResumed` 复活 |
| `session-error-continuable.ts` 瞬时/非瞬时判定 | 用户要求任何中断都可继续 |

### 4. 改法（定稿：同 turn 续跑 —— 失败轮原地复活，不新建输入）

§1 的四条硬要求里，§3 只满足了两条（横幅有按钮、点完能跑），没满足两条关键的：

- **必须在同一个 turn 里续跑**：§3 重发的是新轮 —— 新 turnId、新 turnHeader 行、
  新计时起点。时间线上表现为「一个失败块 + 一个新块」，不是一个块接着长。
- **重试时不得以用户身份发消息、模型不得感知到发生过网络问题**：§3 靠
  `inputVisibility=model-only` 让 UI 不渲染气泡，但**模型上下文里确实多了一条重发的
  正文**。模型看到的是「用户把同一句话又说了一遍」，这本身就是可感知的异常。

§4 把「继续」从「重发输入」改成「把失败的那个 turn 原地复活」。失败轮的 provider 请求
历史本来就还在冷恢复后的 `messageHistory` 里，重跑一次模型请求即可，输入侧零写入。

### 4.1 行为

- 失败照常收口：`TurnError` → 转录落 error assistant 消息、投影落 `failed` header +
  `control.lastError`（现有写入，core 不为续跑加任何分岔）。
- 横幅「继续」发 `resumeSuspendedTurn { failedTurnId }`（命令与 CAS 不变）。
- handler 不再走 `startPromptTurn`，改为 `record.app.runtime.resumeFailedTurn({ failedTurnId })`。
- `resumeFailedTurn` 按 `failedTurnId` 在**持久转录**里定位失败轮：
  1. 读 `sessionStore.messages()`；
  2. `failedTurnId` 命中 user message id → 取它之后**第一条** `error != null` 的
     assistant 消息；否则按该 assistant 消息的 `anchor.turnId === failedTurnId` 匹配。
     两条都落空 → 抛 `fault.turnResume.notFound`（不静默）。
  3. 该失败 assistant 消息的 `parentID` = 该轮 user message id；
     `anchor.turnId` = 该轮 runtime turnId。
- 用**同一个 runtime turnId** 重建 `RegularTurnLoopState` 并跑 `runRegularTurnLoop`：
  - `turnRequestState.entries` = 当前 `messageHistory` 全量 canonical entries
    （冷恢复已灌好，含该轮原始用户输入；失败 assistant 消息按 §4.3 被丢弃）；
  - **不** `persistUserPrompt`、**不** `TurnStarted`、**不** 递增 `turnNumber`、
    **不** 往 `messageHistory` 追加任何 entry。
- 复活瞬间发 `SessionEventType.TurnResumed`（事件 turnId = 失败轮 turnId）：
  投影把该 header 从 `failed` 翻回 `running`、`control.phase` 回 `running`、
  清 `control.lastError`、error-paused 的 queue 恢复 autoDrain。横幅自然消失。
- 续跑成功 → `TurnComplete`（同 turnId）；续跑再失败 → `TurnError`（同 turnId，
  `failed` 重新落回，横幅与按钮再次出现，可再次点）。

### 4.2 状态所有者

| 事实 | 唯一所有者 | 续跑时的读法 |
| --- | --- | --- |
| 失败轮的 provider 请求历史 | 持久转录 + `messageHistory` | 直接复用，不重建 |
| 失败轮身份（turnId / user messageId） | 持久转录（assistant 消息 `anchor.turnId` + `parentID`） | 从转录反查 |
| turnHeader 状态与横幅显隐 | bootstrap 投影 | `TurnResumed` 原子翻回 |
| 模型选择 | Session Selection | 续跑建 Model 时读当前选择（切模型后继续 = 用新模型跑同一上下文） |

**没有内存挂起表**：不缓存 loop state、不做 claim、不设 TTL/预算。重启后照样能继续，
因为续跑所需的全部事实都在磁盘上。

### 4.3 不变量

- **上下文零新增**：续跑不追加任何 `RuntimeMessageEntry`。模型收到的请求前缀与失败前
  那次请求**逐字相同** —— 模型无从感知发生过网络问题。
- **失败 assistant 消息不进模型上下文**：冷恢复的 hydrator 必须跳过
  `error != null` 的 assistant 消息（含流式中断时已落库的半截正文）。live 路径的
  `recoverFromModelFailure` 早就丢弃部分输出，hydration 此前不丢弃，导致冷恢复后
  模型会看到「上次说到一半断了」——这既是不变量缺口，也是 §4 续跑能成立的前提。
- **同一个 turn**：runtime turnId、user messageId、`turnNumber` 三者都不变；
  时间线上是同一个 turnHeader 由 `failed` 翻回 `running` 再到终态，不新增行。
- **轮次映射必须与 header 一起登记**：投影里 `turnIdOf()` 把事件上的 runtime turnId
  翻译成界面上的 productTurnId，靠的是 `productTurnIdByRuntimeTurnId`。正常开新轮时
  这笔登记在 `onTurnStarted` 里写；续跑**不发 `TurnStarted`**，所以 `onTurnResumed` 必须
  自己补上，否则续跑回来的每一条事件都翻译不出 productTurnId，会落到一个凭空多出来的
  幽灵轮次里。后果是那一轮没有 header、转圈与工时等按 header 判定的 UI 全部失效
  （后端明明在跑，界面却不显示运行中）。
  这里必须用事件上的 `String(event.turnId)` 当 runtimeTurnId，不能用已被污染的
  `turnIdOf(event)`。同时补 `currentTurnId`，否则 `acceptsActiveModelEvent` 的轮次隔离
  在续跑轮上失准。
  冷恢复场景尤其致命：失败轮的 runtimeTurnId 是 `hydrate-turn-N` 这类一次性 id，
  而续跑时 core 用的是转录里真实的 `turn_*`，两者本来就不同，不登记必然分叉。
- **工时连续**：失败时刻已结算的 `endedAt/activeMs` 不重算；`running` 期间计时继续，
  终态按恢复后的累计时长收口。
- **幂等**：`TurnResumed` 只对 `failed` 状态的 header 生效，其余状态返回空 delta。
  连点由 UI 的 phase 早退 + 命令 CAS + 状态收敛兜住。
- **拒绝可见**：定位不到失败轮 / 该轮无可续跑的模型上下文时，handler 抛带
  reasonCode 的错误，UI 复用现有发送错误通道展示 `chat.error.continueFailed`。
- **恢复必须持久（否则续跑成功也白成功）**：失败的 assistant 消息是持久行，续跑
  **不会删它**，续跑产出排在其后。若冷恢复见到失败消息就把整轮钉成 `failed`，那么
  「续跑成功 → 重启 → 横幅又回来了 → 再点继续」会变成死循环，用户观感就是
  「每次点的都是坏的」。因此判定必须与 live 的 `recoverFromModelFailure` 同形：
  **一轮里只要失败消息之后还出现了成功的 assistant 产出，这一轮的最终结果由那条
  产出决定，失败只算过程中的一个 carrier，不得盖住终态。**
  末位仍是失败消息（没有后续产出）时才是 `failed`，横幅照常出现。

### 4.4 边界

- **可续跑判据是「这一轮留下过可复用的上下文」，不是「这一轮有没有用户气泡」。**
  续跑是原地复活，`messageHistory` 里的请求上下文与轮次形态无关，所以 model-only 维护轮
  （`/goal` 自动续跑、后台唤醒）同样能续 —— 它们没有 `userInput` 行，按气泡判据会把
  按钮藏掉。UI 因此判「该 failed header 之下是否存在同轮 transcript 行」。
- header 之下没有任何行的失败（模型都没建起来）没有上下文可复用：不显示按钮；CLI 收到
  命令以 `fault.command.resumeSuspendedRejected.notResumable` 明确拒绝，UI 显示
  `chat.error.continueFailed`。
- quota 接管的横幅是订阅升级组件（`takesOverError`），不挂继续按钮。
- 不复用 `retryTurn`（rewind destructive，与保留失败轮矛盾）。
- §3 的 `settleResumedFromTurn`（新轮重开头）与 `intent.resumedFrom` 随本版一并退役：
  没有新轮，就没有重开头。保留会留下第二条写路径。
- 轮内自动重试（`streaming-recovery.ts`，10 次预算）不动 —— 它是同一条链路上更靠前
  的一层，「继续」只是把这层的预算耗尽后的接管点从「新轮」前移到「同轮」。

## 待办

- [x] §3 第一版：删内存挂起表、协议命令 + CAS、投影重开头、UI 挂载点与文案
- [x] §3 第一版：core 删挂起表全链路、shared 删文案筛判定、bootstrap 重写 handler
- [x] §4 定稿（本节）：明确同 turn 续跑，取代 §3 的新轮重发
- [x] §4 core：`resumeFailedTurn`/`beginResumeFailedTurn`（转录反查 + 同 turnId 重建
      loop state + 跑 loop），新增 `resume` runtime command mode（带 branchGeneration 与
      起跑信号），ack 边界 = `TurnResumed` 落库
- [x] §4 core：hydrator 跳过 `error != null` 的 assistant 消息（§4.3 不变量）
- [x] §4 contracts：`SessionEventType.TurnResumed` + payload + retention 重新开 turn +
      cold merge 归 memory-only
- [x] §4 bootstrap：handler 改调 `beginResumeFailedTurn`；投影 `onTurnResumed`
      （failed→running、清 lastError、复原 error-paused 队列、按 userMessageId 回退定位）
- [x] §4 退役 §3 残留：`settleResumedFromTurn`、`intent.resumedFrom`、`prompt-turn.ts`/
      `types.ts` 的 `inputVisibility`/`inputSource` 透传、`resolveResumeSuspendedTarget`
      原文翻译面（投影/发布器/网关/bridge 四级）
- [x] §4 UI：可续跑判据从「同轮有 realUser 气泡」改为「同轮有 transcript 行」
      （model-only 维护轮同样可续）
- [x] §4 测试：投影 3/3（原地翻 running / 幂等 / 再失败）、core 定位 5/5、
      hydration 3/3
- [x] `pnpm typecheck` + `pnpm lint`（唯一 error 是预存的无关改动
      `conversationTurnRenderUnits.ts` 超行数）+ `pnpm architecture:check --changed`（0 violations）
- [x] 重建 core dist + `build:desktop-agent` + `stageAgentBundle`（cliVersion=0.16.57）
- [x] 清死链：退役 §3 时漏删的 `resolveResumeSuspendedTarget` 四层透传
      （commands/types → v4-bridge → v4-gateway → conversation-topic-publisher）
- [x] 离线验证目标会话失败态：真实 transcript 过冷恢复 → 末轮
      `msg_murxzldm_…` 投影 `state=failed`、`control.lastError` 有值、
      按 §4.4 判据 `continuableFailedTurnId` 命中；`resolveFailedTurn` 对同一
      turnId 在真实转录上定位成功
- [x] §4 执行期契约（`core/test/turnResumeExecution.test.ts` 3/3）：跑真实
      `resumeFailedTurnCommand` 到底，锁 §4.3 三条不变量 ——
      ① 输入侧零写入（不落库 user prompt、不注入 user 角色历史条目）；
      ② 同一 turn（复用失败轮 turnId、收尾关在同一轮、不发 TurnStarted、
      turnNumber 不递增）；
      ③ 模型无感：provider 实际收到的前缀 = 失败前原样 3 条（user/assistant/
      tool-result）+ 每轮固定 system 提示，其中不含错误码、不含任何以用户身份
      插入的重试文本。另锁 ack 边界（TurnResumed 落库即 resolve）与
      定位失败时明确 reject、不发 TurnResumed（横幅不假消失）
- [x] §4 handler 契约（`bootstrap/test/resumeSuspendedHandler.test.ts` 3/3）：锁「点击」
      这一跳 —— failedTurnId 原样透传给 core（不被改写成新输入）、成功返回
      `inputAccepted`+`startNow`、起跑后整轮再失败不污染 ack（已转 TurnError 事件）、
      core 拒绝时抛 `V4ResumeSuspendedRejectedError`（UI 显示 chat.error.continueFailed，
      不静默）。链路已核对：SessionPane → dispatchCommand → command.ts 校验器 →
      CommandInbox(CAS) → executor NATIVE_HANDLERS → 本 handler → core
- [x] 持久性修复（实测发现的设计缺陷）：冷恢复原本「见到失败消息即整轮 failed」且
      `failure` / `normalizeTurnResult` 的 error 都会**粘住不清**，于是
      「续跑成功 → 重启 → 横幅又回来」形成死循环，用户观感正是「每次点的都是坏的」。
      已按 §4.3「恢复必须持久」修：失败 carrier 之后出现成功 assistant 产出时，
      由该产出决定终态（`transcript-hydration.ts` 两处），并新增
      `bootstrap/test/failedTurnRecoveryDurability.test.ts` 2/2 锁住双向终态
      （末位仍失败 → failed+横幅；失败后有成功产出 → completedSuccess+无横幅）。
      已验证该测试在无修复时确实失败、修复后通过。
- [ ] 真机验收：失败横幅出现 → 点继续 → 同一 turn 接着跑、无新用户气泡、模型无感知
      （受 AGENTS.md 约束，AI 不得操作/重启 YCode，只能由用户执行）
