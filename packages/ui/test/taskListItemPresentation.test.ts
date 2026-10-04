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
import { mapSessionSummaryToTaskMeta } from "../src/v4/mapSessionSummaryToTaskMeta.js";

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

// plan 卡描边：摘要 → 列表行 sidecar 的透传，以及它与指示位正交。
// 渲染层只读 sidecar 的这个字段决定要不要 ring-1 ring-foreground，
// 所以这里守住「透传不失真」即可，不必断言 className 字符串。

test("lastTurnHasPlanCard 从摘要透传到列表行 sidecar", () => {
  const base = {
    sessionId: "session-1",
    workspaceId: "/repo",
    title: "写计划",
    phase: "completedSuccess" as const,
    sessionEnded: true,
    hasBackgroundWork: false,
    lastActivityAt: 7,
    createdAt: 1,
  };
  const withCard = mapSessionSummaryToTaskMeta(
    { ...base, lastTurnHasPlanCard: true },
    { workspacePath: "/repo" },
  );
  assert.equal(getTaskListRowActivity(withCard)?.lastTurnHasPlanCard, true);

  // 缺席时 sidecar 也必须缺席，UI 按无描边渲染。
  const withoutCard = mapSessionSummaryToTaskMeta(base, { workspacePath: "/repo" });
  assert.equal(getTaskListRowActivity(withoutCard)?.lastTurnHasPlanCard, undefined);
});

test("plan 卡描边与指示位正交：空闲、未读、失败三种圆点都保留该字段", () => {
  const phases = [
    { phase: "completedSuccess" as const, expected: "none" },
    { phase: "error" as const, expected: "error" },
  ];
  for (const { phase, expected } of phases) {
    const row = withActivity({
      phase,
      lastActivityAt: 3,
      hasBackgroundWork: false,
      lastTurnHasPlanCard: true,
    });
    assert.equal(getTaskListRowActivity(row)?.lastTurnHasPlanCard, true);
    assert.equal(
      deriveTaskLeadingIndicator(row, getTaskListRowActivity(row)),
      expected,
      `${phase} 的指示位不该被描边字段影响`,
    );
  }

  // 未读：unreadAt 是 tasks-index membership 字段，描边与它互不干扰。
  const unread = attachTaskListRowActivity({ ...task(), unreadAt: 5 } as ZCodeTaskMeta, {
    phase: "completedSuccess",
    lastActivityAt: 3,
    hasBackgroundWork: false,
    lastTurnHasPlanCard: true,
  });
  assert.equal(
    deriveTaskLeadingIndicator(unread, getTaskListRowActivity(unread)),
    "unread",
    "有 plan 卡不该把未读蓝点降级成别的指示位",
  );
  assert.equal(getTaskListRowActivity(unread)?.lastTurnHasPlanCard, true);
});
