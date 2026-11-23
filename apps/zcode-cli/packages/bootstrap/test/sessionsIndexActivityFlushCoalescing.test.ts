// sessions-index activity-only 帧合并窗口的端到端回归：
// 真实 ConversationV4Gateway → SessionsIndexPublisher → 订阅链路。
//
// 修复前：非 ModelStreaming 事件每次推进 lastActivityAt 都同步直发列表帧
// （工具事件频率 = 帧率，实测重度使用 4–13 帧/秒，UI 侧每帧全量聚合）。
// 修复后：仅活动推进的帧在窗口内合并；可见变化（phase 翻转等）保持立即直发
// 并携带窗口内积压；projection 永远即时推进，新订阅 snapshot 不受窗口影响。
// 见 docs/specs/sessions-index-activity-flush-coalescing.md。
import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  sessionsIndexTopic,
  type RoutedTopicWireFrame,
  type SessionSummary,
  type SessionsIndexTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";

const WORKSPACE_ID = "/repo-activity-flush";
const SESSION_ID = "session-activity-flush";
const TURN_ID = "turn-activity-flush";
const T0 = 1_700_000_000_000;
const WINDOW_MS = 40;

let sequenceNumber = 0;
function event(type: SessionEventType, payload: unknown, offsetMs: number): SessionEvent {
  sequenceNumber += 1;
  return {
    id: `event-activity-flush-${String(sequenceNumber)}`,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    type,
    timestamp: new Date(T0 + offsetMs),
    traceId: "trace-activity-flush",
    sequenceNumber,
    payload,
  } as unknown as SessionEvent;
}

function turnStarted(offsetMs: number): SessionEvent {
  return event(
    SessionEventType.TurnStarted,
    { turnNumber: 1, input: "干活", executionKind: "agent" },
    offsetMs,
  );
}

function turnError(offsetMs: number): SessionEvent {
  return event(
    SessionEventType.TurnError,
    {
      response: "",
      error: { type: "fault.provider.unavailable", message: "provider 挂了", retryable: true },
    },
    offsetMs,
  );
}

function completeWire(wire: RoutedTopicWireFrame): SessionsIndexTopicFrame {
  assert.equal(wire.kind, "complete", "测试帧应远小于分片阈值");
  return wire.frame;
}

function lastSessionSummary(frame: SessionsIndexTopicFrame): SessionSummary | undefined {
  if (frame.payload.kind === "snapshot") {
    return frame.payload.snapshot.sessions.find((session) => session.sessionId === SESSION_ID);
  }
  return frame.payload.deltas
    .filter(
      (delta): delta is Extract<typeof delta, { op: "session.upserted" }> =>
        delta.op === "session.upserted" && delta.session.sessionId === SESSION_ID,
    )
    .at(-1)?.session;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ChainContext {
  gateway: ConversationV4Gateway;
  sent: RoutedTopicWireFrame[];
  errors: Array<{ scope: string; error: unknown }>;
  subscriptionId: string;
  framesFor(subscriptionId: string): SessionsIndexTopicFrame[];
  latestSummary(subscriptionId: string): SessionSummary | undefined;
  advanceActivity(byMs: number): void;
  dispose(): void;
}

async function setupChain(): Promise<ChainContext> {
  sequenceNumber = 0;
  const sent: RoutedTopicWireFrame[] = [];
  const errors: Array<{ scope: string; error: unknown }> = [];
  let activityAt = T0;
  const host = {
    sessionExists: () => true,
    emitWireFrame: (wire: RoutedTopicWireFrame) => sent.push(wire),
    onError: (scope: string, error: unknown) => errors.push({ scope, error }),
    getSessionWorkspaceId: () => WORKSPACE_ID,
    isDraftSession: () => false,
    // 活动事实源：测试按需推进 lastActivityAt，其余摘要字段保持不变。
    getSessionIndexMeta: () => ({ createdAt: T0, lastActivityAt: activityAt }),
  } as unknown as V4GatewayHost;
  const gateway = new ConversationV4Gateway(host, {
    now: () => T0,
    createLogEpoch: () => "activity-flush-epoch",
    sessionsIndexActivityFlushWindowMs: WINDOW_MS,
  });
  const subscribed = await gateway.subscribeSessionsIndexReserved({
    topic: sessionsIndexTopic(WORKSPACE_ID),
    connectionId: "desktop-connection",
    clientMode: "desktop-continuous",
  });
  assert.equal(subscribed.commit(), true);
  // 初始 snapshot 与本测试断言无关，清掉后按「本次 ingest 产生的帧」计数。
  sent.length = 0;

  const framesFor = (subscriptionId: string) =>
    sent.filter((wire) => wire.subscriptionId === subscriptionId).map((wire) => completeWire(wire));
  return {
    gateway,
    sent,
    errors,
    subscriptionId: subscribed.ack.subscriptionId,
    framesFor,
    latestSummary(subscriptionId: string) {
      return framesFor(subscriptionId)
        .map((frame) => lastSessionSummary(frame))
        .filter((summary): summary is SessionSummary => summary !== undefined)
        .at(-1);
    },
    advanceActivity(byMs: number) {
      activityAt += byMs;
    },
    dispose() {
      gateway.dispose();
      assert.deepEqual(errors, [], "在线帧投递不应产生 host 错误");
    },
  };
}

test("仅活动推进的帧在窗口内合并：多次 ingest 只产一帧并携带最新活动", async () => {
  const chain = await setupChain();
  try {
    const { subscriptionId } = chain;

    // 首次发布（prev 缺席）是可见变化：立即直发，建立基线。
    chain.gateway.ingest(SESSION_ID, turnStarted(0));
    assert.equal(
      chain.sent.filter((wire) => wire.subscriptionId === subscriptionId).length,
      1,
      "首次发布必须立即直发",
    );

    // 连续三个活动事件：摘要只有 lastActivityAt 推进 → 不得逐事件直发。
    for (const offset of [1_000, 2_000, 3_000]) {
      chain.advanceActivity(1_000);
      chain.gateway.ingest(SESSION_ID, turnStarted(offset));
    }
    assert.equal(
      chain.sent.filter((wire) => wire.subscriptionId === subscriptionId).length,
      1,
      "窗口未到时 activity-only 帧不得直发",
    );

    // 窗口到期：一次 flush 覆盖全部积压，摘要是最新的活动时间。
    await sleep(WINDOW_MS * 2);
    const frames = chain.sent.filter((wire) => wire.subscriptionId === subscriptionId);
    assert.equal(frames.length, 2, "三个活动事件必须合并成一帧");
    assert.equal(
      chain.latestSummary(chain.subscriptionId)?.lastActivityAt,
      T0 + 3_000,
      "合并帧必须携带最新 lastActivityAt",
    );
  } finally {
    chain.dispose();
  }
});

test("窗口内穿插可见变化：立即直发并携带积压活动，之后不再补帧", async () => {
  const chain = await setupChain();
  try {
    const { subscriptionId } = chain;
    chain.gateway.ingest(SESSION_ID, turnStarted(0));
    assert.equal(chain.sent.filter((wire) => wire.subscriptionId === subscriptionId).length, 1);

    // 活动积压（排队窗口，不直发）。
    chain.advanceActivity(1_000);
    chain.gateway.ingest(SESSION_ID, turnStarted(1_000));
    assert.equal(
      chain.sent.filter((wire) => wire.subscriptionId === subscriptionId).length,
      1,
      "activity-only 不得直发",
    );

    // 可见变化：phase → error 必须立即到达，不需要等窗口。
    chain.advanceActivity(1_000);
    chain.gateway.ingest(SESSION_ID, turnError(2_000));
    const frames = chain.sent.filter((wire) => wire.subscriptionId === subscriptionId);
    assert.equal(frames.length, 2, "可见变化必须立即直发");
    const summary = chain.latestSummary(chain.subscriptionId);
    assert.equal(summary?.phase, "error");
    assert.equal(summary?.lastActivityAt, T0 + 2_000, "立即帧必须连带携带积压的活动增量");

    // 可见 flush 已清窗：再等两个窗口周期也不得冒出补帧。
    await sleep(WINDOW_MS * 3);
    assert.equal(
      chain.sent.filter((wire) => wire.subscriptionId === subscriptionId).length,
      2,
      "可见 flush 清窗后不得有残留补帧",
    );
  } finally {
    chain.dispose();
  }
});

test("窗口未到时新订阅 snapshot 已读到最新活动：延迟只在投递层", async () => {
  const chain = await setupChain();
  try {
    chain.gateway.ingest(SESSION_ID, turnStarted(0));
    chain.advanceActivity(1_000);
    chain.gateway.ingest(SESSION_ID, turnStarted(1_000));
    chain.advanceActivity(1_000);
    chain.gateway.ingest(SESSION_ID, turnStarted(2_000));

    // 窗口未到期就冷读：projection 已即时推进，snapshot 必须拿到最新活动。
    const subscribed = await chain.gateway.subscribeSessionsIndexReserved({
      topic: sessionsIndexTopic(WORKSPACE_ID),
      connectionId: "cold-reader",
      clientMode: "desktop-continuous",
    });
    assert.equal(subscribed.commit(), true);
    const initialFrame = subscribed.initialFrame;
    assert.equal(initialFrame?.payload.kind, "snapshot");
    const snapshot =
      initialFrame?.payload.kind === "snapshot" ? initialFrame.payload.snapshot : undefined;
    const summary = snapshot?.sessions.find((session) => session.sessionId === SESSION_ID);
    assert.equal(
      summary?.lastActivityAt,
      T0 + 2_000,
      "合并窗口只延迟投递；snapshot 读到的是权威最新态",
    );
  } finally {
    chain.dispose();
  }
});
