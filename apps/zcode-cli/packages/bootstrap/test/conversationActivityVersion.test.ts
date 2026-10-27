// 跨端已读水位的 CLI 侧回归（docs/specs/task-completion-read-watermark.md）：
// ConversationSnapshot.lastActivityAt 必须与 sessions-index summary.lastActivityAt
// 同源，并与同一事件的正文 delta 同批发布；冷恢复只能用宿主 record.updatedAt，
// 不能拿 gateway 时钟伪造历史版本。
import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { conversationSnapshotSchema, statePatchSchema } from "@zcode/shared/zcode-protocol-v4";
import { ConversationTopicPublisher } from "../src/zcode-protocol-v4/conversation-topic-publisher.js";
import { SessionsIndexProjection } from "../src/zcode-protocol-v4/sessions-index-projection.js";

const SESSION_ID = "session-activity-version";
const TURN_ID = "turn-activity-version";
const T0 = 1_700_000_000_000;

let sequenceNumber = 0;
function event(type: SessionEventType, payload: unknown, offsetMs = sequenceNumber): SessionEvent {
  sequenceNumber += 1;
  return {
    id: `event-${sequenceNumber}`,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    type,
    timestamp: new Date(T0 + offsetMs),
    traceId: "trace-activity-version",
    sequenceNumber,
    payload,
  } as unknown as SessionEvent;
}

function turnStarted(offsetMs: number): SessionEvent {
  return event(
    SessionEventType.TurnStarted,
    { turnNumber: 1, input: "继续任务", executionKind: "agent" },
    offsetMs,
  );
}

function assistantCompleted(offsetMs: number): SessionEvent {
  return event(
    SessionEventType.ModelComplete,
    {
      assistantMessageId: "assistant-activity-1",
      content: "完成结果",
      stopReason: "end_turn",
      toolCallCount: 0,
      usage: { outputTokens: 1 },
    },
    offsetMs,
  );
}

function lastFrameOf(publisher: ConversationTopicPublisher, subscriptionId: string) {
  const reservation = publisher.reserveFlush(subscriptionId);
  assert.ok(reservation, "expected a flushable frame");
  const frame = reservation.frame;
  assert.equal(reservation.commit(), true);
  return frame;
}

test("活动版本与正文 row delta 同帧，两种 delivery profile 都收到同一版本", () => {
  const publisher = new ConversationTopicPublisher(SESSION_ID, "epoch-activity");
  const subscriptions = [
    {
      profile: "replayable" as const,
      subscribed: publisher.subscribeReserved({
        connectionId: "connection-replayable",
        deliveryProfile: "replayable",
      }),
    },
    {
      profile: "continuous" as const,
      subscribed: publisher.subscribeReserved({
        connectionId: "connection-continuous",
        deliveryProfile: "continuous",
      }),
    },
  ];
  for (const { subscribed } of subscriptions) {
    assert.equal(subscribed.reservation?.commit(), true);
    // 丢掉初始 snapshot 帧，只观察 live 帧。
    publisher.reserveFlush(subscribed.ack.subscriptionId);
  }

  const lastActivityAt = T0 + 1_000;
  const started = turnStarted(1_000);
  publisher.ingest(started, { lastActivityAt });
  assert.equal(publisher.getSnapshot().lastActivityAt, lastActivityAt);

  for (const { subscribed } of subscriptions) {
    const frame = lastFrameOf(publisher, subscribed.ack.subscriptionId);
    assert.equal(frame.payload.kind, "deltas");
    if (frame.payload.kind !== "deltas") continue;
    const deltas = frame.payload.deltas;
    const rowDelta = deltas.find(
      (delta) => delta.op === "row.appended" || delta.op === "row.upserted",
    );
    const activityPatch = deltas.find(
      (delta) => delta.op === "state.updated" && delta.patch.lastActivityAt === lastActivityAt,
    );
    // 正文与活动版本必须在同一帧、同一 seq 区间里出现。
    assert.ok(rowDelta, "row delta missing from activity frame");
    assert.ok(activityPatch, "lastActivityAt patch missing from activity frame");
    assert.equal(frame.toSeq, started.sequenceNumber);
  }

  // wire round-trip：快照与补丁都能被 shared schema 解析，且版本字段保留。
  const wireSnapshot = conversationSnapshotSchema.parse(publisher.getSnapshot());
  assert.equal(wireSnapshot.lastActivityAt, lastActivityAt);
  assert.deepEqual(statePatchSchema.parse({ lastActivityAt }), { lastActivityAt });
});

test("旧快照/旧补丁缺席 lastActivityAt 仍可解析", () => {
  const publisher = new ConversationTopicPublisher(SESSION_ID, "epoch-legacy");
  publisher.ingest(turnStarted(1));
  const { lastActivityAt: _omitted, ...legacySnapshot } = publisher.getSnapshot();
  assert.equal(conversationSnapshotSchema.safeParse(legacySnapshot).success, true);
  assert.equal(statePatchSchema.safeParse({}).success, true);
  assert.equal(conversationSnapshotSchema.parse(legacySnapshot).lastActivityAt, undefined);
});

test("sessions-index summary 与快照同源：快照版本不会被领先的 record.updatedAt 覆盖", () => {
  const publisher = new ConversationTopicPublisher(SESSION_ID, "epoch-summary");
  const activityAt = T0 + 2_000;
  publisher.ingest(turnStarted(2_000), { lastActivityAt: activityAt });

  const index = new SessionsIndexProjection("/repo", "index-epoch");
  const deltas = index.upsertFromConversation(publisher.getSnapshot(), {
    createdAt: T0,
    // 模拟列表摘要先拿到了更新的 record 时间：正文快照仍是 activityAt。
    lastActivityAt: activityAt + 5_000,
  });
  assert.equal(deltas.length, 1);
  const summary = deltas[0];
  assert.equal(summary?.op, "session.upserted");
  if (summary?.op !== "session.upserted") return;
  assert.equal(summary.session.lastActivityAt, activityAt);
});

test("冷 hydrate 使用宿主给定活动版本，并在首个 snapshot 中带出", () => {
  const publisher = new ConversationTopicPublisher(SESSION_ID, "epoch-hydrate", {
    now: () => T0 + 90_000,
  });
  const activityAt = T0 + 7_000;
  const events = [turnStarted(1_000), assistantCompleted(7_000)];
  publisher.rehydrate(events, { lastActivityAt: activityAt });
  assert.equal(publisher.getSnapshot().lastActivityAt, activityAt);

  for (const profile of ["replayable", "continuous"] as const) {
    const subscribed = publisher.subscribe({
      connectionId: `connection-hydrate-${profile}`,
      deliveryProfile: profile,
    });
    assert.equal(subscribed.ack.mode, "snapshot");
    assert.equal(subscribed.frame?.payload.kind, "snapshot");
    if (subscribed.frame?.payload.kind !== "snapshot") continue;
    const snapshot = conversationSnapshotSchema.parse(subscribed.frame.payload.snapshot);
    assert.equal(snapshot.lastActivityAt, activityAt);
  }
});

test("冷 hydrate 缺少宿主活动版本时不拿 now() 伪造历史版本", () => {
  const publisher = new ConversationTopicPublisher(SESSION_ID, "epoch-hydrate-no-meta", {
    now: () => T0 + 90_000,
  });
  publisher.rehydrate([turnStarted(1_000), assistantCompleted(7_000)]);
  assert.equal(publisher.getSnapshot().lastActivityAt, undefined);
});

test("非活动事件不推进快照版本，也不产生多余的活动 patch", () => {
  const publisher = new ConversationTopicPublisher(SESSION_ID, "epoch-non-activity");
  const subscribed = publisher.subscribeReserved({
    connectionId: "connection-non-activity",
    deliveryProfile: "replayable",
  });
  assert.equal(subscribed.reservation?.commit(), true);
  publisher.reserveFlush(subscribed.ack.subscriptionId);

  const activityAt = T0 + 3_000;
  publisher.ingest(turnStarted(3_000), { lastActivityAt: activityAt });
  const first = lastFrameOf(publisher, subscribed.ack.subscriptionId);
  assert.equal(first.payload.kind, "deltas");

  // 标题更新属于非活动事件：宿主 record.updatedAt 不前进，ingest 仍传入同值。
  publisher.ingest(
    event(SessionEventType.SessionTitleUpdated, { title: "新标题", source: "generated" }, 3_500),
    { lastActivityAt: activityAt },
  );
  const second = lastFrameOf(publisher, subscribed.ack.subscriptionId);
  assert.equal(second.payload.kind, "deltas");
  if (second.payload.kind !== "deltas") return;
  const activityPatch = second.payload.deltas.find(
    (delta) => delta.op === "state.updated" && delta.patch.lastActivityAt !== undefined,
  );
  assert.equal(activityPatch, undefined);
  assert.equal(publisher.getSnapshot().lastActivityAt, activityAt);
});
