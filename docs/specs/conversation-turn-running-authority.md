# Spec: 轮内运行态的权威来源与归属

## 目标

轮内过程行（终端 / 思考 / 编辑的逐条明细，以及「已工作」折叠组的默认展开）必须由**权威的运行态**决定，不能由「窗口里此刻有没有行在跑」决定。

## 现状与根因

轮级运行态由 `conversationTurnRenderUnits.ts` 的 `resolveTurnRunning` 判定，三段依次是：

1. 窗口里有轮头（`turnHeader` 行）→ 读 `turnHeader.state`，CLI 投影裁决，权威；
2. 没有轮头但会话阶段是终态 → 不在跑；
3. 都没有 → **回退到行状态猜测**：窗口里存在 streaming 正文 / 思考，或状态为 running / inputStreaming / pendingApproval 的工具行，或 running 的子代理 / marker。

第 3 段是错的来源：

- **轮头会缺失**。窗口按整轮取（`conversation-turn-window.ts`），但一轮自身超过单帧体积预算（`maxFrameBytes - rowsRangeFrameOverheadBytes`，当前 960KB）时会被按行切开，客户端窗口里就只剩该轮的尾段，没有轮头。巨轮（上百次工具调用）必然触到这条。
- **猜测在模型请求空档里必然失真**。工具已结束、下一条工具或思考还没开始的空档里，没有任何行满足 running 谓词 → 判成「不在跑」→ 末段过程行自动收起成聚合摘要；下一条工具或思考一开始 → 又判回「在跑」→ 强制展开回逐条明细。
- **视觉后果不是一行折叠按钮的变化**。展开与折叠之间差几十行，视口贴底时整屏内容随之换掉，用户看到的是两个完全不同的画面：一边是逐条明细，一边是同一轮更早的正文与聚合摘要。同一个任务因此在两种形态之间反复跳。

会话级权威信号一直在协议里：`snapshot.control.phase`（`sessionPhaseSchema`，枚举含 `running` / `prewarming`），属于快照 A 区状态，**不随尾窗裁剪丢失**。CLI 在轮开始时置 `running`，在轮收口时置终态（`product-projection.ts` 的 `onTurnStarted` / `onTurnComplete`），因此整个轮次期间——包括模型请求空档——它一直为 `running`。

## 产品规则

1. **轮头优先**：窗口里有轮头时，运行态仍读 `turnHeader.state`，语义不变，UI 不改写 CLI 的裁决。
2. **会话控制面兜底**：轮头缺失时，会话阶段为 `running` 即表示有轮在跑。`prewarming` 不算——预热时轮还没开始，把它算成在跑会让历史末轮被顶成展开态。
3. **归属规则**：会话运行态只归属**窗口末轮**，且只在**窗口连着会话尾部**（protocol store 的 `contiguousToTail`）时归属。轮导航跳到中部时，窗口末轮是早已完成的历史轮，不得被会话运行态顶成 running——否则读历史时旧轮会错误展开。
4. **空轮不套用**：末轮没有任何工作行时不套用会话运行态，避免造出空的运行中轮次。
5. **会话阶段不可用时才回退猜测**：阶段缺失（`undefined`）时保留现有行状态猜测，兼容旧投影；阶段已知时不再猜测。
6. **用户选择优先**：用户手动收起过程行后，后续工具开始也不自动顶开（既有行为，见 `conversation-process.md`）。

## 状态所有权

- **CLI 投影**：轮头 `turnHeader.state` 与会话控制面 `session.control.phase` 是运行态的唯一 owner，UI 不自造运行态。
- **UI**：`ConversationTimeline` 把「窗口是否连着尾部」与当前会话阶段交给轮次构建；`resolveTurnRunning` 只做归属与兜底，不从行内容反推运行态。

## 事件顺序

```text
snapshot / delta 更新 → session.control.phase 变更（轮开始 running / 轮收口终态）
  → Timeline 建帧（带 windowConnectedToTail）
  → resolveTurnRunning：轮头 → 轮头 state；无轮头 → 会话阶段 × 末轮 × 连尾
  → 轮级 isRunning → 工作段 workStatus.state → 末段过程行 forceOpen
```

## 负面边界

- **不改协议**：`session.control.phase` 已是既有字段，本次不新增协议字段，也不给 `activeWorks` 补 `turnId`——归属用「末轮 × 连尾」即可满足需求，协议面不扩大。
- **不动有轮头时的语义**：`turnHeader.state` 仍是轮内运行态的第一权威，兜底分支只在轮头缺失时生效。
- **不动转圈的分层**：会话级显隐与放置约束仍按 `conversation-chat-running-indicator.md` 执行；本 spec 只管轮内过程行的展开 / 收起。
- **不动增量复用工时口径**：运行中的轮仍然每帧重算（工时吃 `nowMs`），见 `conversation-turn-frame-incremental-reuse.md`。
- **不按行内容猜归属**：末轮与连尾都由窗口结构给出，不由「有没有行在跑」反推。

## 验收

1. 巨轮（超单帧预算、轮头被裁掉）运行中：末段过程行保持展开，模型请求空档里不收起，下一条工具或思考开始后也不发生形态跳变。
2. 同一会话已结束（阶段为终态）：末段过程行保持收起，不因残留的 running 工具行被顶开。
3. 轮导航跳到中部旧轮（窗口脱尾）：该轮保持收起，不被会话运行态顶成展开态。
4. 窗口连着尾部且会话在跑时，只有窗口末轮被判定为运行中；窗口内更早的轮不受影响。
5. 有轮头的轮：运行态仍完全由 `turnHeader.state` 决定，行为与改动前一致。
6. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 与 `packages/ui` 测试通过。
