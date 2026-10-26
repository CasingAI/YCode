import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import type { IntlInstance } from "../src/i18n/index.js";
import { collectTerminalTaskNotificationPayloads } from "../src/lib/taskNotificationOrchestrator.js";

const formatMessage: IntlInstance["formatMessage"] = (({ id }: { id: string }) =>
  `i18n:${id}`) as unknown as IntlInstance["formatMessage"];

function summary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    title: "任务",
    phase: "running",
    sessionEnded: false,
    hasBackgroundWork: false,
    lastActivityAt: 1,
    createdAt: 1,
    ...overrides,
  };
}

function payloadsFor(
  previous: SessionSummary,
  next: SessionSummary,
): ReturnType<typeof collectTerminalTaskNotificationPayloads> {
  return collectTerminalTaskNotificationPayloads({
    previousBySessionId: new Map([[previous.sessionId, previous]]),
    sessions: [next],
    formatMessage,
  });
}

const ITERATING_GOAL_STATUSES = ["active", "verifying", "notSatisfied"] as const;

for (const goalStatus of ITERATING_GOAL_STATUSES) {
  test(`goal 迭代中间态（${goalStatus}）收口不产生完成通知`, () => {
    const payloads = payloadsFor(
      summary({ phase: "running", goalStatus }),
      summary({ phase: "completedSuccess", sessionEnded: true, goalStatus }),
    );
    assert.deepEqual(payloads, []);
  });
}

test("verifier 判定通过（verified）正常产生完成通知", () => {
  const payloads = payloadsFor(
    summary({ phase: "running", goalStatus: "verifying" }),
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "verified" }),
  );
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.status, "completed");
  assert.equal(payloads[0]?.taskId, "session-1");
});

test("用户主动 stop（paused + completedInterrupted）保持静默，不产生通知", () => {
  const payloads = payloadsFor(
    summary({ phase: "running", goalStatus: "active" }),
    summary({ phase: "completedInterrupted", sessionEnded: true, goalStatus: "paused" }),
  );
  assert.deepEqual(payloads, []);
});

test("迭代中任务失败（error + active）仍产生 failed 通知", () => {
  const payloads = payloadsFor(
    summary({ phase: "running", goalStatus: "active" }),
    summary({ phase: "error", goalStatus: "active" }),
  );
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.status, "failed");
});

test("无 goal 的普通会话完成通知行为不变", () => {
  const payloads = payloadsFor(
    summary({ phase: "running" }),
    summary({ phase: "completedSuccess", sessionEnded: true }),
  );
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.status, "completed");
});

test("多轮迭代后最终 verified 边沿正常产生完成通知", () => {
  const previous = summary({
    phase: "completedSuccess",
    sessionEnded: true,
    goalStatus: "notSatisfied",
  });
  const next = summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "verified" });
  const payloads = payloadsFor(previous, next);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.status, "completed");
});

test("verified 帧紧跟被静默的 active 中间态时正常补发完成通知", () => {
  const payloads = payloadsFor(
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "active" }),
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "verified" }),
  );
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.status, "completed");
});

test("verified 帧重复下发不重复通知", () => {
  const payloads = payloadsFor(
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "verified" }),
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "verified" }),
  );
  assert.deepEqual(payloads, []);
});

test("校验中用户 stop 落到 paused 同样静默，不产生通知", () => {
  const payloads = payloadsFor(
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "verifying" }),
    summary({ phase: "completedInterrupted", sessionEnded: true, goalStatus: "paused" }),
  );
  assert.deepEqual(payloads, []);
});

test("无 goal 的普通会话主动 stop 同样静默", () => {
  const payloads = payloadsFor(
    summary({ phase: "running" }),
    summary({ phase: "completedInterrupted", sessionEnded: true }),
  );
  assert.deepEqual(payloads, []);
});

test("上一轮未完成帧之后的迭代 turn 收口帧（同相 active）仍静默", () => {
  const payloads = payloadsFor(
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "notSatisfied" }),
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "active" }),
  );
  assert.deepEqual(payloads, []);
});

// 上一帧 phase 已是 completedSuccess，本帧仍为 completedSuccess，仅 goal 从迭代态
// 转入 paused：完成相位没有新的边沿，不能补发完成通知。
for (const goalStatus of ITERATING_GOAL_STATUSES) {
  test(`完成相位延续、goal 由 ${goalStatus} 仅变为 paused 时不补发完成通知`, () => {
    const payloads = payloadsFor(
      summary({ phase: "completedSuccess", sessionEnded: true, goalStatus }),
      summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "paused" }),
    );
    assert.deepEqual(payloads, []);
  });
}

// 上一帧 phase 仍是 running，本帧 running -> completedSuccess 是新的成功边沿；
// goal 同时为 paused（合帧）或此前已 paused（分帧终点）都必须正常通知。
for (const goalStatus of ["active", "notSatisfied", "paused"] as const) {
  test(`上一帧 running + ${goalStatus}、本帧 completedSuccess + paused 仍产生完成通知`, () => {
    const payloads = payloadsFor(
      summary({ phase: "running", goalStatus }),
      summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "paused" }),
    );
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0]?.status, "completed");
  });
}

test("运行中暂停 goal 与成功收口合帧时仍产生完成通知", () => {
  const payloads = payloadsFor(
    summary({ phase: "running", goalStatus: "active" }),
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "paused" }),
  );
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.status, "completed");
});

test("运行中暂停 goal 与成功收口分帧时只在成功帧通知一次", () => {
  const pausedPayloads = payloadsFor(
    summary({ phase: "running", goalStatus: "active" }),
    summary({ phase: "running", goalStatus: "paused" }),
  );
  assert.deepEqual(pausedPayloads, []);

  const completedPayloads = payloadsFor(
    summary({ phase: "running", goalStatus: "paused" }),
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "paused" }),
  );
  assert.equal(completedPayloads.length, 1);
  assert.equal(completedPayloads[0]?.status, "completed");
});

for (const [label, previous] of [
  ["running + active", summary({ phase: "running", goalStatus: "active" })],
  [
    "completedSuccess + active",
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "active" }),
  ],
] as const) {
  test(`goal 暂停但回合真实失败（${label} -> error + paused）仍产生 failed 通知`, () => {
    const payloads = payloadsFor(
      previous,
      summary({ phase: "error", sessionEnded: true, goalStatus: "paused" }),
    );
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0]?.status, "failed");
  });
}

test("重复的 error + paused 帧不重复失败通知", () => {
  const payloads = payloadsFor(
    summary({ phase: "error", sessionEnded: true, goalStatus: "paused" }),
    summary({ phase: "error", sessionEnded: true, goalStatus: "paused" }),
  );
  assert.deepEqual(payloads, []);
});
