import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type MessageWithParts, type SessionEvent } from "@zcode/contracts";
import type { ReasoningRow } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";

// 冷恢复把 transcript 反向合成事件：思考耗时的起点/终点来自持久化的 part.time，
// 必须透传到合成的 reasoning_start / reasoning_end 事件时间上。
// 若统一落到「基准时间 + seq」，两条事件只差 1ms，恢复后耗时恒为 0。

const T0 = 1_700_000_000_000;

let seq = 0;
function makeEvent(
  type: SessionEventType,
  payload: unknown,
  timestampMs: number,
  turnId = "turn-1",
): SessionEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    sessionId: "sess-hydrate",
    turnId,
    type,
    timestamp: new Date(timestampMs),
    traceId: "trace-1",
    sequenceNumber: seq,
    payload,
  } as unknown as SessionEvent;
}

function streamingEventTime(
  events: ReturnType<typeof synthesizeEventsFromMessages>,
  kind: string,
): number | undefined {
  const event = events.find(
    (candidate) =>
      candidate.type === SessionEventType.ModelStreaming &&
      (candidate.payload as { kind?: string }).kind === kind,
  );
  return event?.timestamp.getTime();
}

function assistantMessageWithReasoning(): MessageWithParts {
  return {
    info: {
      id: "msg-1",
      sessionID: "sess-hydrate",
      role: "assistant",
      time: { created: T0 + 500 },
    },
    parts: [
      {
        id: "part-1",
        sessionID: "sess-hydrate",
        messageID: "msg-1",
        type: "reasoning",
        text: "先想一下",
        time: { start: T0 + 1_000, end: T0 + 7_000 },
      },
    ],
  } as unknown as MessageWithParts;
}

test("冷恢复合成的 reasoning_start/end 事件时间取 part.time，恢复后耗时不为 0", () => {
  const events = synthesizeEventsFromMessages([assistantMessageWithReasoning()], {
    sessionId: "sess-hydrate",
    baseTimestampMs: T0,
  });

  const startMs = streamingEventTime(events, "reasoning_start");
  const endMs = streamingEventTime(events, "reasoning_end");

  assert.equal(startMs, T0 + 1_000);
  assert.equal(endMs, T0 + 7_000);
  assert.equal((endMs ?? 0) - (startMs ?? 0), 6_000);
});

test("冷恢复缺失 part.time.end 时退化为 part.time.start，不产生负耗时", () => {
  const message = assistantMessageWithReasoning();
  message.parts = [
    {
      id: "part-1",
      sessionID: "sess-hydrate",
      messageID: "msg-1",
      type: "reasoning",
      text: "先想一下",
      time: { start: T0 + 1_000 },
    },
  ] as MessageWithParts["parts"];

  const events = synthesizeEventsFromMessages([message], {
    sessionId: "sess-hydrate",
    baseTimestampMs: T0,
  });

  assert.equal(streamingEventTime(events, "reasoning_start"), T0 + 1_000);
  assert.equal(streamingEventTime(events, "reasoning_end"), T0 + 1_000);
});

// 直播与冷恢复必须落在同一个量上：运行时的思考窗口 → part.time → 合成事件 → 投影，
// 得到的 durationMs 要与直播时投影按同一起止时间写入的值完全相等。
// 否则用户看到的现象就是「重启/切回会话后秒数变了」。
test("冷恢复得到的思考耗时与直播同值", () => {
  const startedAt = T0 + 1_000;
  const endedAt = T0 + 7_000;
  const message = assistantMessageWithReasoning();
  message.parts = [
    {
      id: "part-1",
      sessionID: "sess-hydrate",
      messageID: "msg-1",
      type: "reasoning",
      text: "先想一下",
      time: { start: startedAt, end: endedAt },
    },
  ] as MessageWithParts["parts"];

  const coldProjection = new ProductProjection("sess-hydrate", "epoch-1");
  for (const event of synthesizeEventsFromMessages([message], {
    sessionId: "sess-hydrate",
    baseTimestampMs: T0,
  })) {
    coldProjection.applyEvent(event);
  }
  const coldRows = coldProjection
    .getSnapshot()
    .rows.window.filter((row): row is ReasoningRow => row.kind === "reasoning");

  const liveProjection = new ProductProjection("sess-hydrate", "epoch-1");
  for (const event of [
    makeEvent(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi", executionKind: "agent" }, T0, "turn-1"),
    makeEvent(
      SessionEventType.ModelStreaming,
      { kind: "reasoning_start", delta: "", done: false, assistantMessageId: "msg-1", partId: "part-1" },
      startedAt,
      "turn-1",
    ),
    makeEvent(
      SessionEventType.ModelStreaming,
      { kind: "reasoning_end", delta: "", done: false, partId: "part-1" },
      endedAt,
      "turn-1",
    ),
  ]) {
    liveProjection.applyEvent(event);
  }
  const liveRows = liveProjection
    .getSnapshot()
    .rows.window.filter((row): row is ReasoningRow => row.kind === "reasoning");

  assert.equal(liveRows.length, 1);
  assert.equal(liveRows[0]?.durationMs, endedAt - startedAt);
  assert.equal(coldRows.length, 1);
  assert.equal(coldRows[0]?.durationMs, liveRows[0]?.durationMs);
});
