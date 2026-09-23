# Spec: 会话活动时间（侧栏任务时间线分组与排序）

## 目标

按时间分组/排序的侧栏任务时间线（「今天 / 昨天 / N 天前」）里，点开一个几天前的旧会话，行会立刻跳进「今天」组并置顶。根因有两层，必须一起成立才会出现该现象：

1. **时间字段链路**：侧栏分组与排序读的是 Window Controller 任务行 meta 的 `updatedAt`，而它被 sessions-index 的 overlay 覆盖成 `summary.lastActivityAt`，也就是 CLI 内存态 `record.updatedAt`。tasks-index 的 `updated_at` 在时间线里并不署名。
2. **会话级配置类事件漏进活动时间**：`record.updatedAt` 的推进规则是「不在 `isNonActivitySessionEvent` 名单里就 bump」，而名单由人工维护。任何属于会话级配置（不是用户内容活动）、却漏在名单外的会话事件，都会把 `record.updatedAt` 冲成 `Date.now()`。

### 已确认的运行时根因（本次修复的目标）

名单漏项的实际泄漏点是 `followup_mode_changed`，而且它**发生在 resume 收口之后**——所以"只在恢复窗口内收口"这种做法从原理上拦不住它：

```
点击旧任务（record.updatedAt = 旧时间）
  ├─ 07:29:57.296 cold resume flight created
  ├─ 07:29:57.343 event_store.appended  session_title_updated   ← 名单内
  ├─ 07:29:57.344 event_store.appended  session_resumed         ← 名单内
  ├─ 07:29:57.344 resume 收口（窗口内无漂移 ⇒ 收口无日志、无动作）
  ├─ 07:29:57.347 v4 hydrate loaded（此刻 summary 仍是正确旧时间）
  └─ 07:29:57.377 event_store.appended  followup_mode_changed   ← 名单外，漏网
        └─ onSessionEvent：record.updatedAt = Date.now()
        └─ 同一同步块内 v4Gateway.ingest → sessions-index upsert(lastActivityAt = now)
              → 桌面 overlay → 行 meta.updatedAt = now → 侧栏跳进「今天」（点击后约 33ms）
```

触发者不是用户操作，而是 UI 的配置回填：`SessionPane` 发现 v4 投影的 `followupMode` 与 app 级设置不一致时补发 `setFollowupMode` 命令（见 `packages/ui/src/v4/SessionPane.tsx` 的 followup 同步 effect），CLI 因此追加一条 `FollowupModeChanged`。

2026-09-23 的真实日志给这份名单做了普查（110 次 resume / 49 个会话，取 `resume_completed` 之后 5 秒内该会话的全部 `event_store.appended`）：

| 事件类型 | 次数 | 归属 |
| --- | --- | --- |
| `followup_mode_changed` | 95 | 非活动（**本次修复补入**） |
| `session_resumed` | 79 | 非活动 |
| `session_title_updated` | 5 | 非活动 |
| `turn_started` / `session_input_promoted` / `model_request` | 各 4 | 用户真实活动 |
| `session_mode_changed` | 2 | 非活动 |

结论有三条，都是硬结论：

- **恢复窗口内不会出现被误判为活动的种子事件**：除用户真实发起的输入（`turn_started` 等，次数远小于 resume 次数）外，窗口内事件全部属于配置/恢复类。这条普查就是「分类已覆盖真实事件流」的判据。
- **bump 与发帧在同一同步块内**（`record.updatedAt = Date.now()` 紧跟 `context.v4Gateway?.ingest(...)`），帧一旦发出无法事后收回。任何「事后重新锚定」的做法都只能在发帧之前生效，不能作为修复面。
- **真正的修复面是事件分类本身**：配置/恢复类事件不得推进活动时间，且分类必须完整、不得靠逐次补名单。`followup_mode_changed` 覆盖了 86% 的点击，它落在 `resume_completed` 之后约 33ms，任何以恢复窗口为界的收口都看不见它。

本 spec 确立活动时间的唯一事实源、合法写入者、goal 变更的归因规则，以及会话事件的完整分类。活动时间的写入只有一条路径：事件分类。

## 时间字段链路（谁是事实源）

```
侧栏时间线（WorkspaceTimelineTasksSection → groupTaskTimelineItems）
  └─ 行 meta.updatedAt
       └─ Window Controller 投影：有 sessions-index overlay 时被覆盖
          windowHostControllerProjection.ts  updatedAt = overlay.updatedAt
       └─ overlay.updatedAt = summary.lastActivityAt
          windowHostControllerService.ts
       └─ summary.lastActivityAt = CLI record.updatedAt
          v4-bridge.ts  getSessionIndexMeta
```

- **侧栏时间的事实源是 CLI 的 `record.updatedAt`。** 它在 v4 会话索引里表现为 `SessionSummary.lastActivityAt`，经 Window Controller overlay 覆盖到任务行上。
- tasks-index 的 `updated_at` 语义相同，但只服务仍按 membership 取时间的消费者（例如搜索列表，见 `taskQueryCacheStore` 的合并策略：非搜索列表不做 whole-meta winner）。写入它不等于侧栏时间会变；反过来，只改它也不能修复侧栏分组。
- 状态所有者：CLI `record.updatedAt` 是运行态事实源；tasks-index sqlite 是同一语义的持久落点；UI 只读。

## 合法写入者

`record.updatedAt`（= `lastActivityAt`）只有一条写入路径：`onSessionEvent` 中**不在** `isNonActivitySessionEvent` 名单里的用户内容活动事件。除此之外没有任何东西可以写它——包括恢复边界：`activateSessionForResume` 只把 `session.time.created/updated`（持久化事实）回填到记录上，不制造新时间。

tasks-index `updated_at` 的合法写入者：

1. turn 终态：`task_complete` / `task_error`；
2. 权威回源：snapshot / session store 的真实时间（`syncTaskMeta`、`resumeTask` 回源）；
3. goal 变更中的**用户操作**（`source` 为 `command` / `tool`）。

## 规则一：配置/恢复类事件不得推进活动时间

判定入口是 `isNonActivitySessionEvent`（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-activity-event.ts`）。它是一份**必须完整**的分类，成员如下：

| 类别 | 事件 | 为什么不是活动 |
| --- | --- | --- |
| 会话选型配置 | `ModelSelected`、`SessionModeChanged`、`FollowupModeChanged`、`QueueAutoDrainChanged` | 会话级选型/路由开关；UI 在打开会话时会按 app 级设置补写，属配置回填 |
| 会话元数据 | `SessionTitleUpdated` | 标题是元数据；冷恢复每次都会为 v4 投影重发 |
| 恢复/准入 | `SessionResumed`、`WorkspaceHookAdmissionUpdated` | 打开、恢复、重新评估准入是读取，不是活动 |
| hook 生命周期 | `HookRunStarted/Progress/Completed/Failed/Blocked` | turn 内部执行细节；正常 turn 已有内容事件负责推进时间，冷恢复的 SessionStart hook 不能单独制造一次活动 |

- 冷恢复会为 v4 投影补发 `SessionTitleUpdated`：runtime 事件存储是每次实例新建的内存 store，历史标题事件不回灌，`resumeFromStore` 的 `syncPersistedSessionTitleForResume` **每次冷恢复都会重发**。这是投影种子，不是用户活动。
- `FollowupModeChanged` / `QueueAutoDrainChanged` 与 `ModelSelected` / `SessionModeChanged` 同类：都是会话级配置。用户显式切换这类配置也不推进活动时间（沿用既有先例），用户发言轮次照常推进。
- 桌面服务层不得用「本地收到了某条事件」这一事实重新推导活动时间。

## 规则一·补：分类必须完整，不允许出现未归类的会话事件

名单式负枚举天生会漏（本次即漏了 `followup_mode_changed`）。因此：

- 分类的完整性由测试机械保证：新增 `SessionEventType` 成员后，未在「活动 / 非活动」任一侧登记会让测试失败，必须在本次改动里显式归类。
- 遇到"点开旧任务就变成今天"时，先查 `event_store.appended` 的实际 `sessionEventType`，比对分类表，而不是继续给收口打补丁。

## 规则二：goal 变更按 source 归因

`session_info_update.target` 的 `action` / `source` 必须**原样保留**，投影不得压扁（压扁会把用户命令 `command` 写成 `runtime`，使规则无法判定）。

| source | action | 推进活动时间 |
| --- | --- | --- |
| `command` / `tool` | `set` / `cleared` / `status_updated` | 是（用户操作） |
| `runtime` | `run_started` / `run_finished` / `usage_accounted` / `status_updated` / `summary_updated` | 否（runtime 每轮 turn 的自动记账） |

- 判定规则：**只有 `source !== "runtime"` 才推进活动时间**。
- goal 内容（objective/status/tokenBudget）照常落库，与是否推进时间无关。
- 冷恢复合成的那条 `TargetChanged{action:"set", source:"runtime"}`（`cold-event-merge.ts`）只进 v4 投影快照（`publisher.rehydrate`），不走 runtime 事件总线，因此不会经 `session_info_update` 到达服务层；即便到达，`source: "runtime"` 也被本规则拦下。

## 规则三：恢复边界不制造新时间（只回填持久化事实）

- 位置：`activateSessionForResume`（`server-operations.ts`），`record.app.resume()` 之前。
- 行为：`record.createdAt = session.time.created`、`record.updatedAt = session.time.updated`（缺失则不覆盖）。这是把记录对齐到持久化事实，不是推进活动时间；此后 resume 期间补发的种子事件都在规则一名单内，不会再把它冲成 `Date.now()`。
- 为什么不需要「收口」：规则一已经把恢复窗口内实际出现的事件全部归类（见上方普查表），窗口内不存在漏网事件，因此不存在需要在窗口末尾修正的漂移。若将来 resume 真的出现漂移，正确的做法是把它归类进规则一名单，而不是加一层事后重新锚定——那既看不见窗口之后的 bump（本次事故），又制造第二条写入路径。

## 接口

- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-activity-event.ts`
  - `NON_ACTIVITY_SESSION_EVENT_TYPES`：非活动事件集合（唯一分类事实源）。
  - `isNonActivitySessionEvent`：`onSessionEvent` 侧唯一判定入口；`server-operations.ts` 从这里导入。
- `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`
  - `mapSessionInfoLikePayload`：`session_info_update.target` 保留完整 `action` / `source` 枚举（未知值分别回退为 `set` / `runtime`）。
  - `updateTaskIndexFromStreamEvent`：`session_info_update` 仅在事件携带 `target` 时写 `patch.target`（缺省为 `null`，避免把已恢复的 goal 留成 `undefined`）；仅当 `target.source !== "runtime"` 时附带 `updatedAt: Date.now()`。title-only / apiRetry-only 的 patch 不携带 `updatedAt` 键（`applyAgentPatch` 对缺省键保留现值）。
- 其余写入者不变：`task_complete` / `task_error` / 终态迁移 / `syncTaskMeta` 回源 / 手动重命名（明确不推进时间）/ 已读 CAS（写回原值）。

## 状态与时序

```
点击旧任务（record.updatedAt = 3 天前）
  ├─ resumeSession ──▶ activateSessionForResume
  │     ├─ createRecord 写死 Date.now()
  │     ├─ 回填 session.time.created/updated           ← 对齐持久化事实（resume 之前）
  │     ├─ await record.app.resume()
  │     │     └─ 补发投影种子事件（标题 / 恢复 / hook 准入）
  │     │           └─ onSessionEvent：分类表命中 ⇒ 不 bump ✓
  │     └─ 返回（不再有事后收口：写入路径只有分类这一条）
  ├─ hydrate 完成 ──▶ summary.lastActivityAt = record.updatedAt（仍是旧时间）✓
  ├─ UI 配置回填 setFollowupMode ──▶ FollowupModeChanged
  │     └─ 分类表命中 ⇒ 不 bump ✓（修复点：名单漏它就会跳「今天」）
  ├─ 真实活动（发送消息，turn 完成）
  │     └─ task_complete / 活动事件 ──▶ updatedAt = now ──▶ 进入「今天」 ✓
  └─ 用户 /goal 设置 / 清除 / 暂停
        └─ TargetChanged{source:"command"} ──▶ session_info_update{target} ──▶ updatedAt = now ✓
```

## 验收场景

1. 三天前的任务点开后仍停留在「3 天前」分组，标题照常显示/刷新，不发生整表重排。
2. 打开一个持久化的 `followupMode` 与 app 级设置不同的旧任务：UI 补写 `setFollowupMode`，侧栏分组不变（`FollowupModeChanged` 不推进活动时间）。
3. 向该任务发送消息并完成一轮后，任务进入「今天」分组。
4. 用户 `/goal` 设置、清除或暂停目标后，任务按用户活动进入「今天」分组。
5. runtime 的 goal 记账事件（`run_started` / `run_finished` / `usage_accounted` / `summary_updated` / `status_updated`，`source: "runtime"`）不推进活动时间。
6. 手动重命名不推进活动时间（沿用既有行为）。
7. 点开带未读蓝点的旧任务：已读 CAS 清除蓝点，活动时间不变。
8. 带持久化 goal 的旧任务冷恢复时，合成 `TargetChanged` 不推进活动时间。
9. 改前已被错误顶到「今天」的任务，重新冷恢复读一次 snapshot 后回源为真实时间。
10. 新增 `SessionEventType` 成员而未归类时，分类覆盖测试失败。

## 验证

- 回归测试：
  - `apps/zcode-cli/packages/bootstrap/test/sessionActivityEvent.test.ts`：会话事件分类全覆盖（活动 / 非活动两侧之和等于 `SessionEventType` 全集，且互不相交）；锁住 `FollowupModeChanged` / `QueueAutoDrainChanged` 归入非活动、turn/tool/token 类事件归入活动。
  - `packages/services/test/taskIndexActivityTime.test.ts`：真实 sqlite + 桩 agentService 驱动 `onDynamicTaskEvent` 事件流，覆盖标题补发不推进、用户 goal 变更推进、runtime 记账不推进。
- 运行方式：`node --import tsx --test <file>`（仓库未配置统一测试脚本）。
- 反向验证：把 `FollowupModeChanged` 从非活动集合移除，分类用例失败（2 项），确认测试守护该行为。
- 运行时判据（修复依据，非测试）：对 `~/.zcode/cli/log/zcode-*.jsonl` 做事件普查，`resume_completed` 后 5 秒内该会话的全部事件都在上方表格里，无一漏在分类之外。
- 该修复在 CLI 侧（bootstrap 包），需重新构建 / 重启桌面端的 CLI bundle 才会在 UI 生效。
