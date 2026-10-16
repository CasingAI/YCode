import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSidebarTaskViewMode,
  shouldShowPinnedTasks,
  type SidebarTaskViewMode,
} from "../src/WorkspaceSidebar/taskViewMode.js";

test("归档开关将视图切换到归档且隐藏全局置顶区", () => {
  const taskViewMode = resolveSidebarTaskViewMode({
    showArchivedTasks: true,
    taskOrganizeBy: "project",
  });

  assert.equal(taskViewMode, "archived");
  assert.equal(shouldShowPinnedTasks(taskViewMode), false);
});

test("其他任务视图继续显示全局置顶区", () => {
  const taskViewModes: SidebarTaskViewMode[] = [
    resolveSidebarTaskViewMode({
      showArchivedTasks: false,
      taskOrganizeBy: "project",
    }),
    resolveSidebarTaskViewMode({
      showArchivedTasks: false,
      taskOrganizeBy: "chronological",
    }),
    resolveSidebarTaskViewMode({
      showArchivedTasks: false,
      taskOrganizeBy: "grouped",
    }),
  ];

  assert.deepEqual(taskViewModes, ["workspace", "timeline", "grouped"]);
  for (const taskViewMode of taskViewModes) {
    assert.equal(
      shouldShowPinnedTasks(taskViewMode),
      true,
      `${taskViewMode} 应显示置顶区`,
    );
  }
});
