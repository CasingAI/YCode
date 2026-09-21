import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type MessageWithParts } from "@zcode/contracts";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";

// 冷恢复把 transcript 反向合成事件：思考耗时的起点/终点来自持久化的 part.time，
// 必须透传到合成的 reasoning_start / reasoning_end 事件时间上。
// 若统一落到「基准时间 + seq」，两条事件只差 1ms，恢复后耗时恒为 0。

const T0 = 1_700_000_000_000;

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
