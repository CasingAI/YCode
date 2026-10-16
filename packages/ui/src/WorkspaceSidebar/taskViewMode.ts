export type SidebarTaskViewMode = "grouped" | "workspace" | "timeline" | "archived";

export function resolveSidebarTaskViewMode(params: {
  showArchivedTasks: boolean;
  taskOrganizeBy: "grouped" | "project" | "chronological";
}): SidebarTaskViewMode {
  if (params.showArchivedTasks) {
    return "archived";
  }
  if (params.taskOrganizeBy === "chronological") {
    return "timeline";
  }
  if (params.taskOrganizeBy === "grouped") {
    return "grouped";
  }
  return "workspace";
}

export function shouldShowPinnedTasks(taskViewMode: SidebarTaskViewMode): boolean {
  // 归档视图只展示已归档任务，未归档置顶任务不属于该列表。
  return taskViewMode !== "archived";
}
