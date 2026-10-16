import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldShowPinnedTasks,
  type SidebarTaskViewMode,
} from "../src/WorkspaceSidebar/taskViewMode.js";

test("归档视图不显示全局置顶区", () => {
  assert.equal(shouldShowPinnedTasks("archived"), false);
});

test("其他任务视图继续显示全局置顶区", () => {
  const taskViewModes: SidebarTaskViewMode[] = [
    "workspace",
    "timeline",
    "grouped",
  ];

  for (const taskViewMode of taskViewModes) {
    assert.equal(
      shouldShowPinnedTasks(taskViewMode),
      true,
      `${taskViewMode} 应显示置顶区`,
    );
  }
});
