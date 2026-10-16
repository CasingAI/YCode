export type SidebarTaskViewMode =
  "grouped" | "workspace" | "timeline" | "archived";

export function shouldShowPinnedTasks(
  taskViewMode: SidebarTaskViewMode,
): boolean {
  return taskViewMode !== "archived";
}
