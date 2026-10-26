import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary, SessionsIndexTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import type { IntlInstance } from "../src/i18n/index.js";
import { collectTerminalTaskNotificationPayloads } from "../src/lib/taskNotificationOrchestrator.js";
import { applySessionsIndexFrame } from "../src/v4/sessionsIndexStore.js";

const formatMessage: IntlInstance["formatMessage"] = (({ id }: { id: string }) =>
  `i18n:${id}`) as unknown as IntlInstance["formatMessage"];

const WORKSPACE_ID = "workspace-1";
const TOPIC = `sessions-index/${WORKSPACE_ID}`;
const SUBSCRIPTION_ID = "subscription-1";

type SessionsIndexState = Parameters<typeof applySessionsIndexFrame>[0];

function summary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: "session-1",
    workspaceId: WORKSPACE_ID,
    title: "任务",
    phase: "running",
    sessionEnded: false,
    hasBackgroundWork: false,
    lastActivityAt: 1,
    createdAt: 1,
    ...overrides,
  };
}

function emptyIndexState(): SessionsIndexState {
  return {
    workspaceId: null,
    logEpoch: null,
    seq: 0,
    sessions: new Map(),
  };
}

function snapshotFrame(seq: number, sessions: readonly SessionSummary[]): SessionsIndexTopicFrame {
  return {
    topic: TOPIC,
    subscriptionId: SUBSCRIPTION_ID,
    fromSeq: 0,
    toSeq: seq,
    sentAt: seq,
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: WORKSPACE_ID,
        logEpoch: "epoch-1",
        sessions: [...sessions],
      },
    },
  };
}

function upsertFrame(
  fromSeq: number,
  toSeq: number,
  sessions: readonly SessionSummary[],
): SessionsIndexTopicFrame {
  return {
    topic: TOPIC,
    subscriptionId: SUBSCRIPTION_ID,
    fromSeq,
    toSeq,
    sentAt: toSeq,
    payload: {
      kind: "deltas",
      deltas: sessions.map((session) => ({ op: "session.upserted", session })),
    },
  };
}

function applyFrame(
  current: SessionsIndexState,
  frame: SessionsIndexTopicFrame,
): SessionsIndexState {
  const { state, gap } = applySessionsIndexFrame(current, frame);
  assert.equal(gap, false);
  return state;
}

function startIndex(sessions: readonly SessionSummary[]): SessionsIndexState {
  return applyFrame(emptyIndexState(), snapshotFrame(1, sessions));
}

function applyUpsert(
  current: SessionsIndexState,
  toSeq: number,
  sessions: readonly SessionSummary[],
): SessionsIndexState {
  return applyFrame(current, upsertFrame(current.seq, toSeq, sessions));
}

function payloadsBetween(
  previous: SessionsIndexState,
  next: SessionsIndexState,
): ReturnType<typeof collectTerminalTaskNotificationPayloads> {
  return collectTerminalTaskNotificationPayloads({
    previousBySessionId: previous.sessions,
    sessions: [...next.sessions.values()],
    formatMessage,
  });
}

test("合帧：运行中暂停 goal 后直接成功，只产生一次完成通知", () => {
  // snapshot 是 running+active；中间 running+paused 帧被背压合帧丢弃，直接到成功终态。
  const before = startIndex([summary({ phase: "running", goalStatus: "active" })]);
  const after = applyUpsert(before, 3, [
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "paused" }),
  ]);

  const payloads = payloadsBetween(before, after);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.status, "completed");
});

test("分帧：运行中暂停 goal 与成功收口分别到达，只在成功帧通知一次", () => {
  const running = startIndex([summary({ phase: "running", goalStatus: "active" })]);
  const paused = applyUpsert(running, 2, [summary({ phase: "running", goalStatus: "paused" })]);
  assert.deepEqual(payloadsBetween(running, paused), []);

  const completed = applyUpsert(paused, 3, [
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "paused" }),
  ]);
  const payloads = payloadsBetween(paused, completed);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.status, "completed");
});

test("单帧取消：已收口迭代轮后 stop 到 completedInterrupted，保持静默", () => {
  const before = startIndex([
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "active" }),
  ]);
  const cancelled = applyUpsert(before, 2, [
    summary({ phase: "completedInterrupted", sessionEnded: true, goalStatus: "paused" }),
  ]);

  assert.deepEqual(payloadsBetween(before, cancelled), []);
});

test("合帧取消：running 直接到 completedInterrupted，保持静默", () => {
  const before = startIndex([summary({ phase: "running", goalStatus: "active" })]);
  // 中间 paused 帧被合帧丢弃，最终摘要仍是取消终态。
  const cancelled = applyUpsert(before, 3, [
    summary({ phase: "completedInterrupted", sessionEnded: true, goalStatus: "paused" }),
  ]);

  assert.deepEqual(payloadsBetween(before, cancelled), []);
});

for (const goalStatus of ["active", "notSatisfied"] as const) {
  test(`合帧：completedSuccess + ${goalStatus} 仅变为 paused，不补发完成通知`, () => {
    const before = startIndex([
      summary({ phase: "completedSuccess", sessionEnded: true, goalStatus }),
    ]);
    const paused = applyUpsert(before, 2, [
      summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "paused" }),
    ]);

    assert.deepEqual(payloadsBetween(before, paused), []);
  });
}

test("分帧：goal 已 paused 时新回合成功，仍产生完成通知", () => {
  const before = startIndex([summary({ phase: "running", goalStatus: "paused" })]);
  const completed = applyUpsert(before, 2, [
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "paused" }),
  ]);

  const payloads = payloadsBetween(before, completed);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.status, "completed");
});
