# Spec: 扁平任务菜单的「移动到分组」

## 目标

分组行右键（`workspace-grouped-tasks/task-context-menu-content.tsx`）早就有「移动到分组」子菜单，
但侧栏其余入口——按项目展开的 `TaskList`（`WorkspaceSidebarItem.tsx:1118`）、时间线
（`WorkspaceTimelineTasksSection.tsx`）、置顶区（`WorkspacePinnedTasksSection.tsx`）、
工作区标题栏「⋯」下拉（`WorkspaceHeaderSections.tsx:594`）——共用的
`TaskActionMenuContent` 没有该入口。用户在截图里的菜单（置顶/重命名/归档/标记未读/在 Finder 中打开/复制信息/调试）
里找不到分配分组的能力。

本 spec 规定如何在 `TaskActionMenuContent` 里提供「移动到分组」子菜单、
提交语义如何与 `applyGroupedTaskViewOrder` 的全量校验共存、
以及「新建分组并移入」的对话框交互。复用现有分组整树提交链路，不新增服务端接口。

> 修订记录：初版提交实现把 `queryGroupedTaskViewStructure` 返回的外 scope task 引用
> 原样回填进全量提交，真实多工作区库必然触发服务端「包含当前 scope 外的 task」校验失败
> （toast「更新分组顺序失败」）；且 pinned/archived 成员在场同样 throw。本版规定
> 单 scope 提交语义与服务端不可见引用跳过语义，并修正 Header 侧的资格判定。
>
> 正交语义修订：置顶（pinned）与分组正交——置顶管「排在哪里」
> （置顶区在所有视图模式下常驻，`WorkspaceSidebar.tsx:606-612`），
> 分组管「属于哪里」。置顶成员是合法的分组引用，不再被服务端跳过；
> 置顶会话开放「移动到分组」（右键＋Header「⋯」），归属变化直接体现在
> 置顶行的圆形 Tag 上。归档口径维持不变（隐藏但保留 membership，取消归档回组）。

## 产品规则

### 菜单位置与结构

在任务管理分组末尾（「标记为未读」与条件渲染的「在分屏打开」之后、第一条 `Separator` 之前）插入：

```
置顶任务 / 取消置顶
重命名任务
归档任务 / 取消归档任务
标记为未读
在分屏打开            （仅桌面 shell 传入）
移动到分组 >          （仅 groupMenu 传入时渲染）
─────────────────
在 Finder 中打开
─────────────────
复制信息 >
─────────────────
调试 >
```

子菜单内容按此顺序：

```
移出分组              （无归属时禁用）
─────────────────
<颜色点> <组标题> …   （按 structure groups 顺序；当前所在组禁用）
─────────────────
新建分组并移入
```

- 无分组时：只显示「移出分组（禁用）」+「新建分组并移入」。
- 不新增一级分隔线：该 Sub 坐在任务管理分组内部，隐藏时（props 缺省）分隔线数量与
  `task-action-menu-submenus.md` 定义的 3 条（窄屏 2 条）完全一致。
- 文案复用既有 `taskGroup.moveToGroup / removeFromGroup / newGroupAndMove`；
  失败 toast 复用 `taskGroup.updateFailed / taskGroup.createFailed`。

### 数据来源

- `TaskActionMenuContent` 新增可选 props（全部可选，缺省即不渲染该 Sub，老调用点零影响）：

```ts
groupMenu?: {
  groups: Array<{ id: string; title: string; color: ZCodeTaskGroupColor; emoji?: string }>;
  currentGroupId: string | null;
  onMoveToGroup: (groupId: string | null) => void;
  onCreateGroupAndMove: () => void;
};
```

- 数据由 hook `useFlatTaskGroupMenu`（`packages/ui/src/hooks/`）提供：
  菜单打开时对任务所属单 workspace 懒拉一次
  `listGroupedTaskViewStructure({ workspaceScopes: [scope] })`，`groups` 直接展示，
  `currentGroupId` 从 `members[]` 按 `workspaceKey + taskId` 反查。
  **不复用** `useGroupedTaskView`（它持有整树 optimistic view，与扁平列表挂载点生命周期不同）。
- hook 的 `task` 参数是**最小目标** `Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">`，
  只用于构造 scope 与 membership key，不要求完整 meta。
  Header 场景在 `activeTaskMeta` 多源合并落空时，用
  `{ taskId: activeTaskId, workspacePath, workspaceIdentity }` 合成最小目标传入，
  不因 meta 缺失整条子菜单静默消失。
- 动作提交走 `lib/flatTaskGroupMove.ts` 的 `buildFlatMoveOrderInput` 纯函数拼全量
  `OrderInput`，经 `applyGroupedTaskViewOrder` 服务端事务落库（与拖拽/菜单同一提交语义）。

### 提交语义（单 scope task 引用）

`applyGroupedTaskViewOrder` 是全量提交：提交集合外的本 scope task 会被移出 membership/排序，
且服务端对每个 task 引用做 scope 与可见性校验。因此提交集合必须满足：

1. **task 引用只来自本 scope**：顶层 task 节点与各组 `taskRefs` 只保留
   `workspaceKey === 本 scope` 的引用；`queryGroupedTaskViewStructure` 返回的外 scope
   数据（members / 顶层 task 节点）不回填——服务端 scope 外引用直接 throw，
   且外 scope 的 membership 与 `task_group_view_node_orders` task 行不会被本次提交触碰
   （服务端只清理本 scope 的 task 排序行）。
2. **group 顶层节点全局回填**：组是全局资源（`task_groups` 无 workspace 列），
   `base.groups` 全量映射为 `{ type: "group", groupId }` 顶层节点提交，漏提交的组会被
   从顶层排序删除。`base.groups` 里存在但 `topLevelOrders` 缺席的组
   （刚创建、尚未参与过排序）按 `createdAt` 追加到顶层末尾，避免全量提交把新组抹掉。
3. **本 scope 已知 task 收敛**：`members` 与 `topLevelOrders` 里本 scope 的已知 task
   必须全部出现在提交集合，缺的补回顶层（`workspacePath` 从 members/topLevelOrders
   反查，不用 movingTask 的路径猜）。
4. **服务端不可见引用跳过**：`validateTaskRef` 对 `deleted/archived` 或无行的
   task 引用**返回 null 跳过**（不 throw）。原始 structure 不过滤可见性，扁平链路
   从真实库回放出的不可见成员（如已被归档/删除的旧组成员）不能让整个移动失败；
   跳过可保住其 membership 行。**pinned 引用不再跳过**：置顶成员是合法分组引用
   （正交语义），其 `taskRefs`/收敛引用正常参与校验与写入。
   scope 外引用仍 throw（护栏保留，规则 1 保证正常链路不再触发）。
   grouped 视图自身提交（`viewToOrderInput`）只含可见任务，行为不变。

### 可用性规则

- 仅本地 workspace 任务可用：`task.workspaceIdentity` 非空或行有 `remoteSessionId`
  （远端任务）时不传 `groupMenu`（grouped 是本地 workspace-only）。
- archived 任务不可用：`isArchived` 为真时不传 `groupMenu`（归档隐藏但保留 membership，取消归档回组）。
  **pinned 任务可用**：置顶与分组正交，`isPinned` 不再是排除条件——置顶会话的
  「移动到分组」照常渲染，归属变化体现在置顶行的圆形 Tag 上。
- 只读态（`disableTaskActions`）沿用任务管理分组的禁用语义：SubTrigger 禁用并挂
  `disabledReason`；结构加载中时触发器保持可点，点开后组项禁用；
  「新建分组并移入」点击即弹对话框，结构未就绪在确认时提示（见上节）。
- **置顶区（`WorkspacePinnedTasksSection`）的右键菜单沿用本 spec 资格**：置顶行有「移动到分组」；
  已归档会话的右键菜单沿用现有禁用语义。

### 新建分组对话框（两处入口统一）

「新建分组并移入」（本菜单）与分组视图侧栏 # 按钮（`WorkspaceSidebar.tsx`，仅 grouped 模式）
共用 `CreateGroupDialog`（`workspace-grouped-tasks/create-group-dialog.tsx`）：

> 修订记录：初版把对话框状态与渲染放在菜单内容组件（TaskListItem 单例）里，
> 但该组件随菜单关闭即卸载——点确认的瞬间对话框还没渲染就被卸掉，
> 用户实测「点『新建分组并移入』完全没反应」。本版改为 AlertDialogHost 同模式：
> 对话框由 RootShell 级 `CreateGroupDialogHost` 挂载（菜单生命周期之外），
> 打开方经 `flatTaskGroupCreateDialogStore`（zustand）注册确认闭包；
> 闭包持有打开时的 task/scope/structure 引用与提交链路，菜单内容组件卸载后依然可执行。

- 字段：名称 Input（placeholder 走 i18n `taskGroup.createDialog.namePlaceholder`）＋
  颜色（`TASK_GROUP_COLORS` RadioGroup，默认 gray）＋ emoji 触发钮
  （打开 `emoji-picker-dialog`，见 task-group-emoji-and-row-tag.md）。
- 默认值：名称空、颜色 gray、emoji 空。名称留空确认时，UI 显式传 i18n 默认名
  （「新建分组」/"New group"），服务端 `createTaskGroup` 的 `"New Group"` 回落仅作兜底。
- 确认按钮始终可点（pending 中除外）。确认时若分组结构 RPC 尚未回来，
  不猜测全量排序、不留禁用按钮——toast `taskGroup.structureNotReady` 并关闭对话框，
  用户重开菜单会重新拉取结构。
- 确认：带参 `createTaskGroup({ title, color, emoji })`。
  - 本菜单：创建成功后沿用 `submitMove` 把会话移入新组尾，再 `refreshStructure()`，
    全部成功才关闭对话框。两次顺序 RPC（create → move）不是原子事务；中途失败
    组可能已建、任务未移——接受该中间态，不引入补偿删除，统一 toast
    `taskGroup.createFailed`（对话框保持打开，可重试或取消）。
  - 分组视图：创建成功置顶（prepend）；名称非空时不触发 `newGroupSetupId` 的
    内联自动改名（名称留空才进入内联 setup 补命名）。存量组的行内重命名与
    `newGroupInitialFocusGuard` 焦点保护保留。
- 取消 / 关闭（Esc、X、点遮罩）：直接关闭，**不调任何 RPC、不建组、不 toast**；
  pending 中的创建请求不允许误关。

### 失败语义

- move 提交失败（RPC throw）：toast `taskGroup.updateFailed`；hook 无乐观视图，失败即无副作用，
  `refreshStructure()` 后与 sqlite 一致。
- **提交回包复核**：`applyGroupedTaskViewOrder` 对「不可见」引用是跳过语义（不 throw），
  UI 不能假设提交必然生效。提交＋`refreshStructure()` 后按最新 structure 复核
  movingTask 的 membership（`verifyMoveSettled` 纯函数：移入后 members 必含
  `groupId === targetGroupId`；移出顶层后必不含该 taskId）。未生效视为失败：
  toast `taskGroup.updateFailed`。复核是防静默的最后一道——即使服务端语义回退
  （如 host 进程跑旧代码），用户也能看到明确失败而不是「没有任何反应」。
- create 失败（含对话框确认后的创建失败）：toast `taskGroup.createFailed`，
  不做第二次 move 调用。
- 「新建分组并移入」的移动环节（提交 throw 或复核未生效）：toast `taskGroup.updateFailed`
  且**对话框保持打开**（组可能已建，用户可改选已有组重试或取消）；全部成功才关闭。

## 状态所有者与事件顺序

```
右键/打开「⋯」菜单 → useFlatTaskGroupMenu 懒拉 listGroupedTaskViewStructure（单 scope）
        → 用户点组 → buildFlatMoveOrderInput（单 scope task refs + 全局组节点 + 收敛校验）
        → applyGroupedTaskViewOrder (sqlite transaction, 校验失败跳过不可见 ref)
        → refreshStructure 拉最新 structure → verifyMoveSettled 复核 membership
        → 未生效 toast updateFailed（防服务端静默跳过）；生效则静默
        → task_meta_changed 事件 → grouped 视图 refresh；扁平列表经 query cache/membershipVersion 收敛
新建分组并移入：CreateGroupDialog 确认 → createTaskGroup(带参) → submitMove(新组尾, nextBase 含新组)
        → refreshStructure → verifyMoveSettled → 未生效 toast 且对话框保持打开；生效才关闭
```

- 唯一真相源仍是 sqlite `task_group_members`；菜单层不保持第二份归属缓存。
- 服务端、协议、DB schema 都不动；`applyGroupedTaskViewOrder` 全量提交链路原样复用
  （仅 `validateTaskRef` 不可见分支从 throw 改为跳过）。

## 负面边界

- 多标签 Tag（一个会话贴多个 tag）不做：`task_group_members` 主键
  `(workspace_key, task_id)` 决定一会话最多一组，「文件夹」语义保留。
- 服务端不新增 `moveTaskToGroup` 原子接口，不改 `zcode-protocol*` 命令字；
  create+move 不合并为原子事务。
- 分组行自己的 `GroupedTaskContextMenuContent` 不动（动作集不同，它没有复制/调试项）。
- 拖拽入组、新建组按钮（# 按钮）、重命名/删除组、组颜色行为不动
  （# 按钮仅改为先弹 CreateGroupDialog）。
- 归档区（`WorkspaceArchivedTasksFlatSection`）没有右键菜单，不涉及。
- Header 下拉在 `taskMenuOpen && activeTaskId` 时才拉分组结构（与既有
  pinned/archived 懒查询同口径），不增加首屏 RPC。
- `queryGroupedTaskViewStructure` 返回面不动（不在此过滤可见性，避免波及 grouped 视图）。

## 验收

1. 多工作区真实库（库内存在其他 workspace 的组成员与置顶任务）：时间线右键移动会话
   到已有组 → 成功、无失败 toast，刷新后仍在组内；其他 workspace 的组归属不受影响。
2. 同一会话在主区顶部「⋯」菜单出现「移动到分组」且移动成功；`activeTaskMeta`
   落空（仅快照兜底）的会话同样出现；**置顶中的活动会话同样出现**。
3. 右键 → 移动到分组 → 新建分组并移入 → 弹 CreateGroupDialog，填名称/颜色/emoji 确认后
   新组按所填创建且会话在其组尾；取消则无任何 RPC、无新组。
4. 分组视图 # 按钮弹同一对话框，确认后新组置顶；名称非空时不二次进入行内改名。
5. 远端任务、archived 任务、`groupMenu` 缺省的右键 → 无「移动到分组」项；
   **pinned 任务（置顶区行、置顶中的 Header 活动会话）的右键/「⋯」菜单有该项且可移动**，
   其余菜单项与分隔线行为不变（默认 3 条、窄屏 2 条），控制台无报错。
6. 提交失败（mock `applyGroupedTaskViewOrder` 抛错）→ toast 失败，刷新后与 sqlite 一致；
   提交「成功」但 membership 未变化（服务端静默跳过 movingTask）→ 同样 toast 失败，
   「新建分组并移入」路径对话框保持打开可重试。
