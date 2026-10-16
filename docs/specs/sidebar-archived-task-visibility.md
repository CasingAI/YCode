# Spec: 侧栏归档视图仅显示已归档会话

## 目标

侧栏切换到归档视图时，任务区域只展示已归档会话。未归档的置顶会话不属于归档内容，因此归档视图不渲染全局置顶区。

## 规则与所有者

- `WorkspaceSidebar` 是侧栏任务视图分区的唯一装配者；它把归档开关与组织方式解析为 `SidebarTaskViewMode`，再根据模式决定是否渲染置顶区。
- 归档开关为 true 时，模式必须解析为 `archived`，并隐藏 `WorkspacePinnedTasksSection`。
- `archived` 模式渲染归档任务列表，不渲染 `WorkspacePinnedTasksSection`。
- `workspace`、`timeline` 和 `grouped` 模式继续渲染全局置顶区，保持现有行为。
- 归档/置顶成员关系仍由现有任务列表查询与 membership 规则决定；本次不改变查询、数据持久化、缓存、归档/取消归档操作或自动归档。
- 置顶与归档任务的互斥关系不变；本次只调整视图装配，不移动或重分类任何任务。

## 验收

1. 归档视图只显示已归档会话，未归档的置顶会话不显示在其上方。
2. 归档列表仍正常显示，切换离开归档视图后其他任务视图的置顶区行为不变。
3. 单测覆盖归档开关到归档模式再到隐藏置顶区的完整纯逻辑链，以及其他组织模式的置顶展示。
4. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
