# Spec: 工作区 Header 会话标题的取值权威

## 目标

工作区 Header（`WorkspaceHeaderTitleSection` 的 `<h1>`）显示当前会话标题。置顶（pinned）或归档（archived）的会话被打开时，标题会显示成占位文案「新建任务」，而侧栏同一行显示的是真实标题。本 spec 确立标题的唯一取值权威与优先级，并规定置顶/归档会话必须显示真实标题。

## 现象与根因

标题由 `useWorkspaceActiveTaskState` 的 `activeTaskTitle` 驱动（`packages/ui/src/hooks/useWorkspaceActiveTaskState.ts`），取不到真实标题就回退 `taskList.newThread`（中文「新建任务」）。它依赖的 `resolvedActiveTaskMeta` 有三条来源，而这三条对置顶/归档会话全部落空：

| 来源 | 为何取不到 |
| --- | --- |
| `zcodeSessionStore.taskListCache` | 任务列表已迁到 `taskQueryCacheStore`，该缓存全仓唯一写入方 `taskListMetaSync.ts` 只做「过滤移除」，从不写入，实际恒空 |
| `zcodeSessionStore.optimisticTaskListByTaskId` | 仅在重命名、标记未读、归档等用户写操作之后回写；单纯打开会话不写 |
| `taskQueryCacheStore.taskMetaByEntityKey` | `useWorkspaceTaskLists` 固定以 `kind: "timeline"` 构建，而 `matchesTaskListMembershipKind` 的 timeline 就是 `!pinned && !archived`，置顶/归档任务被结构性剔除 |

剩下的兜底 `useActiveTaskSnapshotMeta` 走 legacy ZCode Protocol 的 `readSession`，对冷会话必然失败：`Session is not active`（抛出点 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-types.ts`）。此时会话正文仍由 v4 `conversation/<sessionId>` 正常渲染，于是出现「正文有内容、标题却是新建任务」。

这不是「置顶后立刻坏」，而是**任何时候打开置顶/归档会话都可能坏**：只要用户没在打开后做过重命名这类写操作，缓存里就没有它的 meta。未置顶会话在 timeline 列表中，query cache 命中，标题一直正常。

## 取值规则

标题按固定优先级取第一个非空值，空串与纯空白视为空：

1. **`meta` 标题** — `resolvedActiveTaskMeta.title`。这是用户写操作（重命名）的权威，含 `titleOverridden` 合并语义。
2. **sessions-index 标题** — v4 `sessions-index` 中该 `sessionId` 的 `summary.title`。这条 lane **与 membership 无关**，覆盖 timeline / pinned / archived 全部会话，与侧栏标题同源。
3. **占位文案** — 以上都为空时：有 meta 且带 `forkedFromTaskId` 取 `taskList.forkedUntitled`，否则取 `taskList.newThread`。

### 为什么 meta 排在 sessions-index 前面

重命名时新标题先落 tasks-index，再经 `session_title_updated` 异步回流到 session summary。若让 sessions-index 当唯一权威，改完名的瞬间 Header 会闪回旧标题。meta 优先可以在改名的可见窗口内保持新值不变，代价是 sessions-index 只作为 meta 缺失时的兜底，而不是全局唯一来源。

### sessions-index 订阅口径

Header 侧订阅 scope 必须与 `useWorkspaceTaskLists` 完全一致，否则 `sessionsIndexRegistry` 会为同一 endpoint+workspace 登记两条 entry：多建 store、多发一条 subscribe；若两条 entry 的 workspaceKey 相同而 agentService 不同，还可能把侧栏正在使用的本机 `__base__` entry 挤掉。

scope 构造抽在 `packages/ui/src/lib/buildSessionsIndexScopes.ts`，规则：

- 本机不带 `endpointKey`，远端 shard 带 `remoteSessionId`——省略规则对齐 `shardKey = resolvedServices.remoteSessionId ?? "__base__"`。
- `workspaceIdentity` 只在 truthy 时展开，与 TaskLists 的对象形状保持一致，避免订阅去重时 scope 引用抖动。
- **remote-waiting 时返回空数组**。该状态下 `useWorkspaceServicesResolution` 给的是断连代理 services，而 TaskLists 在同一状态下整条 config 直接 skip、不进 scopes。若这里仍构造 scope，就会拿断连代理在 `__base__` key 上新建 entry：既订阅失败，又可能挤掉同 workspaceKey 的本机 entry。门控取 `targetReady`（即 `connectionKind !== "remote-waiting"`），**不能取 `rpcReady`**——后者还额外折叠了 transport 就绪度，会比 TaskLists 更严格、再次造成口径分叉。

订阅经 `sessionsIndexRegistry` 引用计数复用，侧栏与 `SessionPane` 已在订阅同一 endpoint+workspace，因此 Header 接入**不新增 RPC**。

### 已知代价：App 级的重渲染

`useWorkspaceActiveTaskState` 由 App 调用，把 sessions-index 订阅挂进 App，等于让每次 sessions-index 帧（新建会话、状态流转、标题回流）都重渲一次 App 子树。这与本文件原先「直接读 store，避免任何列表刷新把整棵 App 一起带着重渲」的取舍方向相反。

缓解事实：`useWorkspaceSessionsIndexItems` 内部经 `stabilizeTaskListItems` 做引用稳定，内容等价时返回同一个数组引用，因此 `sessionsIndexTitle` 的 memo 依赖不会额外抖动，下游（Header 及其消费者）不会因此重渲；且 sessions-index 是 conflated 低频列表事件，不属于高频 snapshot。

若后续实测发现 App 重渲成本不可接受，仓内已有更轻的先例可参照——`WorkbenchPane.tsx` 明确选择直连 registry store、不使用 `useWorkspaceSessionsIndexItems`。届时可降级为单 session 粒度的订阅。

## 不在范围内

- **不改「置顶/归档会话不出现在主列表」**。`timeline = !pinned && !archived` 是正确的产品规则（置顶任务归「已置顶」区），只是 Header 曾误把它当成标题来源。本次只在标题这条读路径上绕过。
- **不修 legacy `readSession` 的 `Session is not active`**。那是 legacy 协议侧没有 active session 的问题，属另一条代码路径；本次保留该兜底作为非置顶冷会话的第二来源。
- **不改 `activeTaskMeta` 本身的合并链**。sessions-index 标题只从标题这一个出口兜底，不并入 `activeTaskMeta`，避免波及 status / model / provider / changeSummary 的现有行为。
- **不补 provider / traceId 等其他 header 字段**。置顶会话的这些字段仍从原路径取，更多菜单里的「打开会话日志」对置顶会话可能仍缺 provider。扩成 meta 全字段补齐是独立议题。
- **不重命名任何字段**。sessions-index 摘要保留自己这份消费实例的 `titleOverridden` 修正（`mapSessionSummaryToTaskMeta` 依赖该实例的 `previousItemsRef`），Header 是新增的第 N 个实例，其 `previous` 从空开始。重命名后、summary 尚未标 `titleSource: "custom"` 的窗口内，sessions-index 侧可能仍给出旧标题——但 meta（query cache 带 `titleOverridden`）优先级更高，实际盖住。仅记录，不在本次处理。

## 验收

1. 打开已置顶会话 → Header 显示真实标题，不是「新建任务」；正文渲染不变。
2. 打开已归档会话 → 标题显示真实标题。
3. 打开未置顶会话 → 标题与改动前一致（无回归）。
4. 重命名一个已置顶会话 → 立即显示新标题，不闪回旧值。
5. 新建任务草稿（`activeTaskId === null`）→ 仍显示「新建任务」。
6. 冷启动后直接打开置顶会话 → 首帧允许短暂占位，hydration 完成后自动变正确，不永久卡住。
7. `node --test` 覆盖优先级、回落与 scope 构造（本地 / 远端 / remote-waiting / 空 identity）；`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。

单测命令：

```
node --import tsx --test packages/ui/test/workspaceActiveTaskTitle.test.ts
```