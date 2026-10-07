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

test("goal 迭代 turn 收口（active）不产生完成通知", () => {
  const payloads = payloadsFor(
    summary({ phase: "running", goalStatus: "active" }),
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "active" }),
  );
  assert.deepEqual(payloads, []);
});

test("verifier 判定未完成收口（notSatisfied）不产生完成通知", () => {
  const payloads = payloadsFor(
    summary({ phase: "running", goalStatus: "notSatisfied" }),
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "notSatisfied" }),
  );
  assert.deepEqual(payloads, []);
});

test("verifier 进行中（verifying）不产生完成通知", () => {
  const payloads = payloadsFor(
    summary({ phase: "running", goalStatus: "verifying" }),
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "verifying" }),
  );
  assert.deepEqual(payloads, []);
});

test("verifier 判定通过（verified）正常产生完成通知", () => {
  const payloads = payloadsFor(
    summary({ phase: "running", goalStatus: "verifying" }),
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "verified" }),
  );
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.status, "completed");
  assert.equal(payloads[0]?.taskId, "session-1");
});

test("用户 stop 使 target 暂停（paused + completedInterrupted）仍产生通知", () => {
  const payloads = payloadsFor(
    summary({ phase: "running", goalStatus: "active" }),
    summary({ phase: "completedInterrupted", sessionEnded: true, goalStatus: "paused" }),
  );
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.status, "completed");
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

test("校验中用户 stop 落到 paused 不被同相去重吞掉", () => {
  const payloads = payloadsFor(
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "verifying" }),
    summary({ phase: "completedInterrupted", sessionEnded: true, goalStatus: "paused" }),
  );
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.status, "completed");
});

test("上一轮未完成帧之后的迭代 turn 收口帧（同相 active）仍静默", () => {
  const payloads = payloadsFor(
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "notSatisfied" }),
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "active" }),
  );
  assert.deepEqual(payloads, []);
});
