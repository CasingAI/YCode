# Spec: 任务菜单的归档态切换

## 目标

任务右键菜单和工作区标题栏「⋯」下拉共用 `TaskActionMenuContent`。该组件的归档行是无条件渲染的：文案恒为「归档任务」，回调恒为 `onArchiveTask`，组件签名里没有归档态输入。

结果是：打开一条已归档任务后，标题栏菜单里仍然写着「归档任务」。点了它会先弹一次归档确认框，然后 `archiveTask` 把 `archived` 重写成同一个值（幂等），什么也没发生——用户看到的是「白弹一个框，任务还在归档区」。

本 spec 规定归档行的文案与动作按当前任务的归档态切换，并确立归档态在标题栏的唯一取值来源。

## 现象与根因

归档行写死在 [TaskActionMenuContent.tsx](../../packages/ui/src/TaskActionMenuContent.tsx) 里，文案恒为 `taskList.archive`。i18n key `taskList.unarchive` 与 service 的 `unarchiveTask` 都已存在，侧栏归档区的 Undo2 按钮正在正常使用，唯独标题栏这条路径没接。

接不上的原因是标题栏手里没有归档态这个事实：

- 归档任务结构性不在 timeline 列表里。`matchesTaskListMembershipKind` 规定 `timeline = !pinned && !archived`、`pinned = pinned && !archived`、`archived = archived`，所以归档任务只出现在 archived 视图。
- 标题栏只懒加载查了 pinned 一张表来算 `isPinned`，从来没查过 archived，因此传给菜单的 props 里没有归档态。
- `ZCodeTaskMeta` 不带 `archived` / `archivedAt` 字段，归档态在 UI 层没有任何常驻来源。
- 归档任务仍可被打开：点侧边栏归档区某一行会走 `onSelectTask`，`activeTaskId` 指向它，标题栏照常渲染。

于是得到「已归档的任务 + 一个只会归档的菜单」。

## 取值规则

### 归档行的文案与动作

归档行的位置、顺序、`disabled` 条件、`title` 理由全部不变，只在文案与回调上二选一：

| 归档态 | 文案                                 | 回调              |
| ------ | ------------------------------------ | ----------------- |
| 未归档 | `taskList.archive`（归档任务）       | `onArchiveTask`   |
| 已归档 | `taskList.unarchive`（取消归档任务） | `onUnarchiveTask` |

菜单结构一行不变，行数与分隔线数量在两种归档态下完全相同——这一行只换文案，不换层级。

### 归档态的唯一来源

归档态由标题栏新增的一条 archived 列表查询判定，形态与现有的 pinned 查询完全一致：`useGlobalTaskList({ kind: "archived", ... })`，`workspaceTabs` 同样由 `taskMenuOpen && activeTaskId` 门控，因此只在菜单打开时存在，首屏查询数不变。

判定式是 `archivedItems.some((task) => task.taskId === activeTaskId)`。

**为什么这个判定是精确的、不受分页影响**：该查询传 `expanded: true`，于是 `limit` 为 `undefined`（useGlobalTaskList.ts:119）；`normalizeLimit` 对 undefined 返回 `null`（taskIndexRepo.ts:265-269），SQL 不带 `LIMIT` 子句，返回该 workspace 范围内全部归档行；`hasMore` 是 `total > rows.length`，在全量返回下恒为 false（taskIndexRepo.ts:1894）。

若将来这条查询改成分页加载，本条判定即失效，必须同步改为按 taskId 的成员关系查询。

### 为什么不从会话快照取归档态

协议层的 `ZCodeSessionInfo` 带 `archivedAt` 字段，CLI 侧也在填，看起来投影出来就能用。本 spec 明确不依赖它：`useActiveTaskSnapshotMeta` 走 legacy `readSession`，对冷会话必然抛 `Session is not active`（见 `workspace-header-task-title.md`），而归档任务恰恰只在冷态下被打开（打开它们正是 timeline 列表结构性排除它们的原因）。这条通道在最需要的时候失效。

### 为什么不加 `ZCodeTaskMeta.archived` 字段

sqlite 的 `archived` 列是归档态的唯一写入权威（taskIndexRepo.ts:1820-1826）。在 meta 上再加一个字段会形成第二条写入路径，与「避免重复状态和多条写入路径」冲突。归档态只从成员关系查询来。

## 交互规则

### 取消归档不做二次确认

与侧栏归档区的 Undo2 按钮一致。归档保留现有 ConfirmDialog，不对称的理由是取消归档是撤销动作、归档是破坏性动作。

### 取消归档后不关闭当前会话

不调 `removeTaskState`。那个 action 会在删除或归档时把 `activeTaskId` 置空（zcodeSessionStoreTaskSlice.ts:868-875），用它会把用户正在看的对话一起关掉。取消归档后任务回到时间线区，对话保持打开。

### 取消归档后的缓存变更

成功后写一次 `applyTaskQueryCacheMutation`，`previousState: { pinned: isPinned, archived: true }` → `nextState: { pinned: isPinned, archived: false }`。

`pinned` 沿用标题栏已有的 `isPinned`，不做额外推断。归档任务理论上可能同时 `pinned = 1`，而 pinned 列表按规则排除归档任务，所以标题栏读到的 `isPinned` 对归档任务恒为 false，可能把它放回时间线区而不是已置顶区。这不影响正确性：adapter 在 `unarchiveTask` 之后发出 `task_unarchived` 成员关系事件，controller 注册表按 membership delta 失效并重拉相关查询，缓存会自愈。乐观写只需要方向正确。

### 其他动作在归档态下的行为

置顶、重命名、标记为未读在归档态下仍然可用，本次不额外禁用。归档行的 `disabled` 条件与 `title` 理由仍走既有的 `taskTargetActionsDisabled` / `disabledReason`，只读态下归档态与未归档态表现一致。

### 成员关系加载中的表现

归档态查询与 pinned 查询共用同一个 `taskMenuMembershipLoading` 门控：任一张表还在加载，任务管理动作就保持禁用。归档行在加载期间显示哪一个文案不做特殊处理——文案二选一只依赖 `isArchived`，加载中时它按最后一次已知值渲染。

## 成员关系不得写死

标题栏里所有 `applyTaskQueryCacheMutation` 的 `previousState.archived` 必须写真实归档态，不得硬编码 `false`。归档态任务在标题栏做重命名、置顶、标记未读时，缓存是靠这个状态决定任务该从哪些列表移走的；写入一个明知为假的值会让查询缓存与 archived 列短暂分叉。

`handleArchiveTask` 自身的 `previousState` 是唯一例外：那条路径的前提就是任务当前未归档。

## 不在范围内

- **不改分组任务列表的右键菜单**（`workspace-grouped-tasks/task-context-menu-content.tsx`）。它是独立实现，没有标题栏那套成员关系来源，动作集也不同。本次不碰它那份写死的归档行。
- **不改侧栏归档区的 Undo2 与删除按钮**。它们已经是正确的取消归档入口，本次不合并、不替换。
- **不修 legacy `readSession` 的 `Session is not active`**。属另一条代码路径，`workspace-header-task-title.md` 已列为范围外。
- **不为 Controller 新增按 taskId 的成员关系查询**。整列表判定已经精确，新增协议面不值。
- **不改归档的二次确认对话框**。
- **不碰自动归档**（`runWorkspaceTaskAutoArchive`）。

## 验收

1. 手机窄屏打开一条已归档任务 → 标题栏「⋯」里显示「取消归档任务」，不再显示「归档任务」。
2. 点「取消归档任务」→ 不弹二次确认；该任务出现在侧栏时间线区、归档区里消失；对话区保持打开不跳转；再次打开「⋯」变回「归档任务」。
3. 打开一条未归档任务 → 菜单与改动前逐行一致，行数与三条分隔线的位置不变。
4. 归档态任务点「重命名」→ 改名生效，归档区里那一行的标题同步更新，不出现「时间线里冒出一条重复任务」。
5. 桌面端窄视口（≤768px）打开归档任务 → 菜单少「在 Finder 中打开」，剩两条分隔线，不出现相邻两条横线。
6. 只读态打开归档任务 → 归档行灰掉且悬停有禁用理由，与未归档任务一致。
7. `node --test` 覆盖归档态下的文案切换与分隔线数量；`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。

单测命令（必须进到 `packages/ui` 目录跑，`@/` 别名解析依赖 cwd；在仓库根执行会报 `Cannot find package '@/lib'`）：

```
cd packages/ui && node --import tsx --test test/taskActionMenuSubmenus.test.ts
```
