# Spec: 沙盒实例状态会话投影推送（替代客户端轮询）

## 背景与目标

沙盒控制台面板左侧「沙盒」分区（`SandboxStatusSection`）的显隐，来自
`useSandboxStatus` hook 的本地 `knowledge` 状态，靠
`service.sandboxStatusV4(...)` 定时轮询决定（活着 5000ms / 缺席 1000ms）。
点击「重置实例」后，右侧内容区经 `refresh()` 立刻变空
（`SandboxConsoleDeadOverlay`），但左侧卡片要再过数秒才消失：
` sandboxReset` 成功后没有任何事件/失效/推送去立即刷新轮询状态，两条通道不同步。

目标：把「沙盒实例状态」做成会话投影快照的一部分，由 CLI 在沙盒
生命周期变化时随同一个 `v4/conversation/frame` topic 推送，UI 改为订阅该投影，
删除 `useSandboxStatus` 的轮询，与子智能体（Subagent）状态使用同一套机制。

## 状态所有者与事件顺序

```text
唯一所有者：CLI 进程级沙盒实例表
  apps/zcode-cli/packages/core/src/sandbox/session.ts :: getSandboxInstanceTable()
  （key = sessionId；子代理各用各的 sessionId，自然隔离）

已确认写入（推送投影）：
  控制台 sandboxEval 新实例（推 true）/ sandboxReset 销毁旧实例并立即新建
  干净实例（推 true，即新实例的存活值；旧语义"只销毁"见「缺陷一」）
    → handler 经 coreHost.refreshSandboxProjection → 网关在同一会话的
       ConversationTopicPublisher 上提交
       state.updated { sandbox: { revision+1, alive } }（out-of-band 直推，
       不走 SessionEvent 流；投递通道见「缺陷二」，不再是 commitDeltas(currentSeq)
       记账的老形态）
  订阅建立后冷恢复对账（reconcileSandboxProjectionAfterHydration）
  模型 Sandbox 工具成功（onToolCallResult 自愈：仅 false→null）
    → 同一 publisher 上提交 state.updated
  → 各订阅者 flush buffer → 按 profile.flushWindowMs 打帧
     （continuous 30ms / replayable 150ms）
  → 同一 v4/conversation/frame topic（conversation/<sessionId>）
  → UI SessionDataLayer.onFrame → ConversationProjectionStore.handleFrame
  → useSyncExternalStore 即时重渲染（useConversationProjection）

  out-of-band 状态变更走「state-only 帧」通道（缺陷二修复后）：
  帧区间为 (N,N] 零宽度（不推进、不伪造 seq），payload 仅 state.updated。
  UI 的 applyFrame 对该通道豁免 `toSeq <= seq` 丢弃守卫，
  以补丁自带的 sandbox.revision 做单调守卫（旧/重复投递不回退）。

不推送（无观察者、不进投影）：
  堆超限 dispose / 常驻回收 / 进程退出 → 实例表内部 dispose，
  投影保持最后已确认态，直到下一次事件/订阅收敛（见「未解决问题 3」）

读路径（单向，无第二条写入路径）：
  SessionPane.snapshot.sandbox → ConversationStatusPanel props
    （sandboxAlive: boolean | null 三态）
    → shouldRenderSandboxSection 门控显隐
  SandboxConsoleSidePane.tab 的死亡覆盖 ← 同一快照（经 pane 的 SessionDataLayer
    lease 订阅；tab 不可见时不订阅、不推送打扰）
```

三态语义（本 spec 的核心不变量）：
`alive=true`（已确认活着）/ `false`（已确认死亡）/ `null`（未观测）。
`null` 绝不能被 UI 读成死亡：新 CLI 初始态、旧 CLI 快照缺席键、
模型工具路径创建实例但投影尚未被已确认写入触碰时均为 null，
UI 一律回退工具卡证据旧语义（该开则开、该盖不盖）。

- **一个 owner**：CLI 实例表是执行权威；`snapshot.sandbox` 是它的只读投影。
  UI 不再持有 `knowledge` 本地真相；`sandboxStatusV4` 查询仅保留为网关
  冷恢复对账（`reconcileSandboxProjectionAfterHydration`）的服务端读法，
  UI 不再有任何轮询/兜底读法。
- **一条路径**：`v4/conversation/frame` 是唯一推送通道，不新增 topic/方法名。
  新增的只是 snapshot/delta schema 里的一个 additive 键 `sandbox`。
- **显式时间**：推送延迟 = 命令 ACK 后直推 commit + flushWindowMs
  （桌面 ≤30ms，手机 ≤150ms），不再有 1s/5s 轮询节拍。
  幂等：同值变化不 bump revision、不产 delta（与 `materializeSubagentProjection`
  的语义去重同规）。
  stale 规则：普通帧按既有 subscriptionId + seq 区间记账；state-only 帧
  不参与 seq 单调性，按补丁自身 sandbox.revision 记账（旧/重复投递不回退），
  投影键随 snapshot 同生共死，不断档猜测。
- **桌面/手机**：同一 owner、同一 sequence；delivery 差异只在既有
  continuous/replayable profile（desktop 直接实时流，mobile snapshot + gap repair），
  本功能不新增 delivery 分支。

## 协议设计

`packages/shared/src/zcode-protocol-v4/snapshot.ts` 新增（additive，旧端剥离即降级）：

```ts
export const sandboxProjectionStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  /** 活实例是否在内存（null = 未观测；false = 已确认死亡，与 sandboxStatusV4 unavailable 对齐）。 */
  alive: z.boolean().nullable(),
  /** unsupported / read_failed 等查询侧失败不进投影：投影只表达实例存在性事实；
      查询失败时 UI 按「未观测」处理（见 UI 章节），不把失败写成死亡。 */
});
export type SandboxProjectionState = z.infer<typeof sandboxProjectionStateSchema>;
```

- `conversationSnapshotSchema` 新增 `sandbox: sandboxProjectionStateSchema.optional()`。
  optional 只服务旧快照 wire 兼容；新 CLI 的初始态始终携带
  `{ revision: 0, alive: null }`（未观测——绝不能被读成死亡）。
- `delta.ts` 的 `statePatchSchema` 新增 `sandbox: sandboxProjectionStateSchema.optional()`。
  键级整体替换（Object.assign），键内不深合并；coalesce 规则 2（相邻
  state.updated 浅合并）与 profile filter（只看 `row.delta` 的 streamPaths）
  对新键天然通用，无需改动。
- **revision 语义**：`snapshot.sandbox.revision` 是该键自己的单调计数
  （与 `subagents.revision` 同形，供 UI 去重与 tab 回收对账）；
  conversation 级 `revision` 是否递进，沿用 `deltaBumpsRevision` 的既有键表决策
  ——本 spec 定为：`sandbox` 变化 **bump conversation revision**
  （列入 `REVISION_BEARING_PATCH_KEYS`），理由：reset/创建是用户显式动作的终态，
  一会话至多低频数次，不存在 workflowRuns 那种高频抖动；且 `sandboxReset`
  不在 `COMMANDS_REQUIRING_BASE_REVISION` 集合里，不会制造 CAS 假失败。
- `packages/shared/src/zcode-protocol/index.ts` 无需改动（sandbox-console 的
  query schema 已由此导出；快照键经 `zcode-protocol-v4` index 导出）。

## CLI 推送触发点（为何不用 SessionEvent）

沙盒实例变化**不经过** core 事件流：

- 模型 `Sandbox` 工具调用走 tool handler（`core/src/tool/handlers/sandbox.ts`），
  直接调实例表 `getOrCreate`，不发射任何 SessionEvent；
- 控制台 `sandboxEval` / `sandboxReset` 走 v4 命令 handler（bootstrap），
  直接调 `record.app.evalSandboxForUser` / `resetSandboxInstance`，命令完成
  后无事件写入（`v4-gateway.ts:2645 executeCommand` 之后直接 settle ACK）；
- 常驻回收/堆超限/进程退出走实例表内部 `dispose`，更无事件。

新增 SessionEvent 类型会要求：contracts 事件枚举 + memory-only/TRANSCRIPT_DERIVED
分类 + normalizer/reducer 词汇 + 冷恢复 merge 诊断，四处开销只为表达一个布尔。
而 `ConversationTopicPublisher.commitDeltas` 已是「投影推进 + 日志记账 +
扇出订阅者 buffer」的现成记账路径（`markDesynced` 即先例：无对应权威事件，
直接 commit 一批 delta 走相同扇出），且 `commitDeltas(seq, deltas)` 会把 delta
记入保留窗日志、`scheduleFlush` 按既有窗口打帧——恢复/resume/coalesce 语义
完整复用。

因此采用 **`publishSandboxState(sessionId)` 直推** 形态：

1. `ConversationTopicPublisher` 新增方法（`conversation-topic-publisher.ts`）：
   ```ts
   /** 沙盒实例存在性直推：快照推进 + 记账扇出；同值无操作。 */
   publishSandboxState(alive: boolean): void
   ```
   内部经 `ProductProjection.setSandboxState(alive)`：
   `previous = snapshot.sandbox ?? { revision: 0, alive: null }`；
   `alive` 同值 → 返回空数组（不 bump revision、不产 delta、不调度 flush）；
   null→true/false 的第一次落定同样产 delta（null 与布尔永不相等，
   不会被去重吞掉）；true/false 翻转各 +1。
   投递走 state-only 帧通道（缺陷二）：
   不伪造、不推进、不借用事件序号；帧区间为 (N,N] 零宽度，
   不记入保留窗 resume 日志（`entry.seq > base.seq` 回放不到它；
   断线重连靠下一次 subscribe/resync 的 snapshot 收敛）。
   同一按键的重复投递以 sandbox.revision 单调守卫（旧的不回退）。
2. 网关新增薄方法（`v4-gateway.ts`）：
   ```ts
   refreshSandboxProjection(sessionId: string, alive: boolean): void {
     this.ensurePublisher(sessionId).publishSandboxState(alive); // 无订阅者时仅推进投影
     for (const [routeKey, state] of this.flushStates) {        // 有订阅者才调度
       if (state.sessionId === sessionId) this.scheduleFlush(routeKey, state, publisher);
     }
   }
   ```
   无订阅者时同样推进投影（与 sessions-index 的「无订阅者也推进」同规），
   保证下一次 subscribe 的 snapshot 即权威当前态。
3. 触发接线（`v4-bridge.ts` 的 `coreHost` + `context.v4Gateway` 同文件共存，
   经可选宿主钩子透传，不改 `V4CommandCoreHost` 必填面）：
   - `sandbox-console.ts` 的 `sandboxEval` 成功且 `isNewInstance`（新实例诞生）
     → 完成后 `refreshSandboxProjection(sessionId, true)`；
   - `sandboxReset` 成功（`kind: "reset"`）→ 完成后
     `refreshSandboxProjection(sessionId, true)`——reset 语义为「销毁旧实例并
     立即新建干净实例」（缺陷一），推的是新实例的存活值，不再推死亡；
   - 失败态（`unavailable`/`unsupported`）不推：投影只表达存在性事实，
     查询失败不写成死亡。
   - 模型 `Sandbox` 工具调用创建实例的路径：工具结果落 transcript
     `ToolCallResult` 事件时，`ProductProjection.onToolCallResult` 内做
     **过期死亡断言撤销**：`success && row.toolName === "Sandbox" &&
     snapshot.sandbox?.alive === false` → `setSandboxState(null)`
     （false→null，revision +1）。成功只能证明「实例曾活着」，
     不能证明「此刻仍活着」（跑完后可能已被回收/超限销毁）——
     所以只撤销过期的已确认死亡，绝不写成 alive=true，更不碰已确认的 true。
     工具名用字面量 `"Sandbox"` 比对（`SANDBOX_TOOL_NAME` 未经 contracts
     barrel 导出，为一个投影比对扩大协议导出面不值）。
4. 冷恢复语义：沙盒堆内存不跨进程（spec sandbox-system-tool.md 既定）。
   `hydratePublisher` 重建后，网关在订阅建立处以实例表当前值对账
   （`reconcileSandboxProjectionAfterHydration`）：
   查询回 alive→推 true（已确认活着），unavailable→推 false（已确认死亡）；
   查询失败/能力缺席→保持未观测 null，不写成死亡。
   `rehydrate` 批量路径不碰该键（初始态即 `{ revision: 0, alive: null }`）。
5. 常驻回收/堆超限 dispose：实例表内部 `dispose` 无回调。
   本 spec 不在实例表加观察者（core 包无投影依赖方向）；
   回收场景的入口消失靠「下一次事件/订阅收敛 + 工具卡证据顶住」，
   不再有轮询降级（轮询已删除）。**取舍见「未解决问题」第 3 条**。

## UI 改动

- `SessionPane.tsx`：`subagents` 旁新增
  `const sandboxProjection = snapshot?.sandbox ?? { revision: 0, alive: null }`；
  传给 `ConversationStatusPanel` 一个三态 prop：`sandboxAlive={sandboxProjection.alive}`
  （`boolean | null`；本轮门控只用 `alive`，revision 供将来 tab 回收对账）。
  `sandboxToolEvidence` 保留：投影未观测（`alive=null`：新 CLI 初始态 /
  旧 CLI 快照缺席键 / 死亡被模型工具成功撤销后）时，有工具卡证据才开门——
  null 绝不能被读成死亡。
- `ConversationStatusPanel.tsx`：删除 `useSandboxStatus` 调用，
  `canRenderSandbox = shouldRenderSandboxSection({ parentSessionId,
  hasOpenHandler, sandboxAlive, sandboxToolEvidence })`。
  无 `sandboxStatusUnknown` 中间态——三态 `alive` 本身即全部信息。
- `conversationStatusPanelModel.ts`：
  `shouldRenderSandboxSection({ parentSessionId, hasOpenHandler,
  sandboxAlive?: boolean | null, sandboxToolEvidence? })`：
  `true`→开门；`false`→关门（聊天卡留着也不开）；
  `null`/`undefined`→回退工具卡证据（有证据开门、无证据关门）。
  `shouldCoverSandboxConsoleAsDead({ projectionAlive?: boolean | null,
  snapshotAlive? })`：`projectionAlive === false` 即覆盖；
  `null`/`undefined` 一律不盖；内容快照 `alive:false` 保留为兜底。
- `SandboxConsoleSidePane.tsx`：删除 `useSandboxStatus` 调用；
  经 pane 的 `V4PaneConversationProvider` 拿到的 `SessionDataLayer` 上
  `acquire(tab.sessionId)` 取 lease，用 `useConversationProjection(lease)`
  读 `snapshot.sandbox.alive`（tab 可见才订阅；不可见释放，
  与 `useSandboxConsole` 的可见门同规）。`handleReset` 保留 `refresh()`
  作即时反馈（右侧快照通道不动），左侧卡片由投影帧驱动。
- `useSandboxStatus.ts`：删除文件。调用者仅面板与 tab 两处（`pnpm dep:refs` /
  全仓 grep 复核），`services` 侧 `sandboxStatusV4` 查询保留
  （仅供网关冷恢复对账 `reconcileSandboxProjectionAfterHydration` 调用，
  UI 不再有任何轮询/兜底读法）。
- 日志：UI 用 `packages/ui/src/logger.ts`；本功能无新增高频日志，
  推送侧沿用网关既有 `onError` 诊断通道。

## 已知缺陷与修复（2026-10）

### 缺陷一：reset 语义是"删空"而不是"重置"

`resetSandboxInstance`（core `runtime/methods/sandbox-console.ts`）只调
`table.dispose(sessionId)`，不重建；`SandboxPort.reset` 的契约
（contracts `interfaces/sandbox.port.ts:87-88`）明写"销毁实例再建新实例"，
但 `instance-table.ts:199-201` 的实现只是 `dispose` 的别名。
按钮文案「重置实例」，行为却是删空：reset 后 `hasLiveInstance === false`，
直到下次 eval 才 `getOrCreate`。旧 spec 与旧投影推送（reset 推 `alive=false`）
把这套行为当正常设计写了下来。

修复：reset 改为「销毁旧实例并立即新建一个干净实例」，幂等
（对不存在的实例执行重置，同样产出可用新实例）。
同一次命令里把投影推成新实例的存活值（`refreshSandboxProjection(sessionId, true)`，
成功且新实例存活才推；重建失败则不推，见下）。
失败/异常语义（不再加兜底分支）：
- 重建抛错 → 结果 `unavailable`（与旧 catch 路径同 kind），不推投影；
- 会话缺席/能力缺席 → 沿用既有抛错（`requireRecord` /
  `V4CapabilityUnsupportedError`），不推投影；
- `dispose` 本身不抛（实例表既有语义：缺席即 no-op）。

### 缺陷二：out-of-band 直推的零宽度帧永远到不了 UI

旧 `publishSandboxState` 用 `commitDeltas(this.currentSeq, …)` 不推进序号
（与 `markDesynced` 同形），追平态（`sentSeq === currentSeq === N`）下
`reserveFlush` 产出 `fromSeq=N, toSeq=N` 的零宽度 delta 帧；
UI `applyFrame` 的 `if (frame.toSeq <= current.seq) return`
（`conversationProjectionStore.ts:859-862`）把它当重复帧整帧丢弃；
`setSandboxState` 同值去重保证之后不再重推。
三段绞杀，补丁永久丢失。旧 spec 把「不推进 seq」当正常设计描述，
正是本缺陷的文字根因。

修复机制（候选 (a)/(b) 中选 **(a)：state-only 帧通道**）：

- (a) 给 out-of-band 状态补丁一条不参与 seq 单调性的合法通道：
  帧区间仍为 (N,N]，由补丁自身的 `sandbox.revision` 做单调守卫。
  UI 的 `applyFrame` 在既有 `toSeq <= seq` 丢弃守卫**之前**，
  对「零宽度 + payload 全是 `state.updated` + 含 `sandbox` 键」的帧走
  state-only 分支：revision 比本地新才 apply，否则丢弃。
- (b) 让状态变更搭载一个权威的非 transcript 会话事件、走正常非零宽度帧：
  需要新 SessionEvent 类型 + contracts 枚举 + normalizer/reducer 词汇 +
  冷恢复 merge 诊断四处开销，只为表达一个布尔——旧 spec 当年为同样理由
  否决过这条路；且事件会进 transcript 派生与 hydration 口径，爆炸半径更大。

取舍：选 (a)。(a) 不动事件流、不动序号不变式、不动 transcript 口径；
代价是恢复语义弱一档：state-only 帧不记入保留窗 resume 日志，
断线客户端重连后靠 snapshot 收敛（下一次 subscribe/resync 的 snapshot
即权威当前态；`refreshSandboxProjection` 无订阅者时同样推进投影，
保证首帧即当前态）。沙盒投影本就是"最后已知存在性"弱状态，
与快照同生共死是可接受语义（同 spec 既有 stale 规则）。

事件顺序图（reset，含两个修复）：

```text
UI 点击「重置实例」
 → sandboxReset 命令 → record.app.resetSandboxInstance
 → table.dispose(session)          # 旧实例销毁，后台 ID 全失效
 → table 建新干净实例（同一次命令内；LocalStorage 按既有语义保留）
 → kind:"reset" 上行 ACK
 → host.refreshSandboxProjection(sessionId, true)
 → publisher.publishSandboxState(true)   # 投影推进，revision+1
 → scheduleFlush → reserveFlush 产出 (N,N] state-only 帧
 → 同一 v4/conversation/frame topic
 → UI handleFrame → applyFrame state-only 分支
    → sandbox.revision > 本地 revision → apply → snapshot.sandbox = {alive:true}
 → useSyncExternalStore 重渲染，分区保持可见（新实例已就绪）
```

验收场景（追加，旧场景 2 被缺陷一覆盖重写）：

7. 空闲会话（无后续事件）中 reset → 已追平客户端在下一个 flush 窗口内
   （桌面 ≤30ms / 手机 ≤150ms）收到 state-only 帧，分区状态收敛到新实例
   存活值；回归测试覆盖（publisher + store 双侧，见下）。
8. reset 语义：有实例时 reset → 旧堆状态消失（此前 `globalThis` 变量不可见）、
   LocalStorage 保留、新实例立即可 eval；无实例时 reset → 同样产出可用新实例
   （幂等），命令结果仍为 `kind:"reset"`。
9. 重建失败（新实例建不出来）→ 结果 `unavailable`，不推投影，分区保持旧态；
   不引入乐观更新与额外兜底分支。
10. 乱序/重复 state-only 帧（旧 revision）→ UI 丢弃，不回退已更新的状态。

## 无 session 沙盒场景结论

`sandboxStatusV4` 参数只有 `sessionId`，实例表 key = sessionId，
`configureSandboxTableDeps` 按 sessionId 登记 FS 宿主——**沙盒实例恒为
session 归属，不存在无 session 的沙盒**。控制台 tab 的 `tab.sessionId`
即拥有者会话；子代理各用各的 sessionId。投影放在会话快照里即全覆盖，
无需 window/workspace 级投影。本 spec 明确不支持无 session 形态，
也不留兼容分支。

## 负面边界（不做什么）

- 不新增 topic / RPC 方法名 / SessionEvent 类型；`sandboxStatusV4` 的
  `services` 侧查询保留（仅供网关冷恢复对账调用，UI 无轮询/兜底读法）。
- 不动 `useSandboxConsole` 的 2s 内容轮询（执行行 + console 窗口仍是 query 面）。
- 不为常驻回收/堆超限加实例表观察者（见未解决问题 3）。
- 不改 `COMMANDS_REQUIRING_BASE_REVISION`（sandbox 命令不进 CAS 门）。
- 不改 delivery profile / flush 窗口 / coalesce / filter 规则。

## 验收场景

1. 新会话首次 `Sandbox` 调用成功 → 右上角「沙盒」分区在下一帧出现
   （desktop ≤30ms + 一次 flush 窗口，不再等 1s 轮询节拍）。
2. 控制台点「重置实例」→ 右侧立刻变空（既有 `refresh()`），旧实例堆状态
   消失、LocalStorage 保留；同一次命令内新干净实例就绪，投影推新实例存活值，
   左侧卡片保持可见（reset 不再经过死亡态）。ACK 失败时卡片不动（不推）。
   回归分支：模型 `Sandbox` 工具创建实例后（投影仍为 null 未观测），
   分区靠工具卡证据仍渲染、已开 tab 不被误盖「已死亡」。
3. 控制台 `sandboxEval` 在新实例上成功（`isNewInstance`）→ 分区出现
   （覆盖「无工具卡、只有控制台创建」的路径）。
4. CLI 重启后打开旧会话 → 对账查询回 unavailable 即推已确认死亡，
   分区不出现；`Sandbox` 工具卡仍在时间线里（历史卡不顶门）；
   下一次 `Sandbox` 成功后，自愈先把过期死亡撤销为 null（入口靠证据重现），
   控制台新实例 eval 再推已确认活着。
5. 旧 CLI + 新 UI：快照无 `sandbox` 键（`alive=undefined` 即未观测）→
   退化为「工具卡证据」旧语义，不 crash、不误关门。
   新 CLI + 旧 UI：旧 UI 剥离未知键，其余 patch 照收（statePatch 容器非 strict）。
6. 同值重复 reset 只产一个 delta（revision 只 +1）；无订阅者时的 reset
   仍推进投影，下一次订阅首帧即新实例存活态。
   null→true→false→true 每次落定各 +1，不被去重吞掉。
   （reset 成功后投影恒为 alive=true，不再出现旧语义的 false 落定；
   false 仍保留给冷恢复对账查询回 unavailable 的路径。）

## 未解决问题 / 取舍

1. **reset ACK 与投影帧的竞态**：UI 在 ACK 成功后本地无乐观更新，
   左侧消失时刻 = 下一帧到达时刻（≤150ms）。若要 ACK 当刻即消失，
   需在 `SandboxConsoleSidePane.handleReset` 里加 optimistic overlay
  （renderer 草稿态，与 pendingCommands 同类），本轮不做——150ms 内旧卡
   多留一帧可接受，且避免引入第二份真相。
2. **模型 `Sandbox` 工具路径的弱即时性**：`ToolCallResult` 自愈只撤销
   过期的已确认死亡（false→null），不写 alive=true——成功只能证明
   「实例曾活着」，不能证明「此刻仍活着」（工具跑完后实例可能已被
   回收/超限销毁，而回收路径无推送）。因此模型调用后、控制台 eval 前，
   分区靠工具卡证据显示（弱即时），已确认活着仍需一次控制台/命令侧写入。
   要把模型路径也做到强即时，需在 core 工具 handler 内加
   core→bootstrap 新通道（依赖方向 core→bootstrap 不存在），本轮不做。
3. **常驻回收/堆超限无推送**：实例表 `dispose` 无观察者，core 包不能依赖
   bootstrap 投影。为这两个低频路径加跨包回调，代价大于收益。
   现无轮询兜底：回收后投影保持最后已确认态（多为 true），直到下一次
   事件/订阅收敛；期间工具卡证据仍在，入口不会误消失，但已死亡实例的
   卡片可能多留——与「不能把确认死亡写成还活着」同等重要，
   记录为后续优化点（实例表观察者或回收事件）。
