import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  deriveTaskLeadingIndicator,
  isTaskListRowProjectionDesynced,
} from "../src/lib/taskListItemPresentation.js";
import {
  attachTaskListRowActivity,
  getTaskListAttention,
  getTaskListRowActivity,
  type TaskListRowActivity,
} from "../src/v4/taskListRowActivity.js";

function task(): ZCodeTaskMeta {
  return {
    id: "session-1",
    status: "running",
    createdAt: 1,
    updatedAt: 1,
  } as unknown as ZCodeTaskMeta;
}

function withActivity(activity: TaskListRowActivity): ZCodeTaskMeta {
  return attachTaskListRowActivity(task(), activity);
}

test("真实等待确认时 running spinner 与等待徽标允许同时出现", () => {
  const row = withActivity({
    phase: "running",
    lastActivityAt: 1,
    hasBackgroundWork: false,
    pendingInteractions: { permissionCount: 0, userInputCount: 1 },
  });

  assert.equal(deriveTaskLeadingIndicator(row, getTaskListRowActivity(row)), "loading");
  assert.deepEqual(getTaskListAttention(row), { kind: "userInput", count: 1 });
});

test("权威终态到达后 spinner 与等待徽标同时消失", () => {
  const row = withActivity({
    phase: "completedSuccess",
    lastActivityAt: 2,
    hasBackgroundWork: false,
  });

  assert.equal(deriveTaskLeadingIndicator(row, getTaskListRowActivity(row)), "none");
  assert.equal(getTaskListAttention(row), null);
});

test("持久 status=running 不能单独触发实时 spinner", () => {
  assert.equal(deriveTaskLeadingIndicator(task(), null), "none");
  assert.equal(getTaskListAttention(task()), null);
});

// ── 投影失同步 vs 本轮真失败 ──
//
// 两者 phase 都是 error，但语义完全不同：前者是投影没接住事件（会话可能早就跑完了），
// 会自愈；后者是这一轮真的失败了。列表若一律画成红色失败点，用户会以为输出丢了。

test("投影失同步与本轮真失败同样是 error，但必须能被区分", () => {
  const desynced = withActivity({
    phase: "error",
    lastActivityAt: 3,
    hasBackgroundWork: false,
    lastErrorCode: "fault.projection.desynced",
  });
  const genuinelyFailed = withActivity({
    phase: "error",
    lastActivityAt: 3,
    hasBackgroundWork: false,
    lastErrorCode: "fault.provider.unavailable",
  });

  assert.equal(isTaskListRowProjectionDesynced(getTaskListRowActivity(desynced)), true);
  assert.equal(isTaskListRowProjectionDesynced(getTaskListRowActivity(genuinelyFailed)), false);
  // 两者都仍走 error 指示位——失同步不该显示成「一切正常」。
  assert.equal(deriveTaskLeadingIndicator(desynced, getTaskListRowActivity(desynced)), "error");
  assert.equal(
    deriveTaskLeadingIndicator(genuinelyFailed, getTaskListRowActivity(genuinelyFailed)),
    "error",
  );
});

test("非 error 的 phase 一律不算失同步", () => {
  for (const phase of ["running", "completedSuccess", "draft"] as const) {
    const row = withActivity({
      phase,
      lastActivityAt: 4,
      hasBackgroundWork: false,
      lastErrorCode: "fault.projection.desynced",
    });
    assert.equal(
      isTaskListRowProjectionDesynced(getTaskListRowActivity(row)),
      false,
      `${phase} 不该被当成失同步`,
    );
  }
  assert.equal(isTaskListRowProjectionDesynced(null), false);
});
