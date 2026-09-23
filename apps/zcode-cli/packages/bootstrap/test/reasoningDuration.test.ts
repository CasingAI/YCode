import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { ReasoningRow } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

// 思考行耗时：必须由「开行的 reasoning_start 事件时间」与「闭合事件时间」算出，
// 且冷恢复重放同一事件日志时得到同一个值。旧实现从不写 durationMs，
// UI 只能用组件挂载时刻现算，刷新/重挂载即丢失或归零。

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
    sessionId: "sess-reasoning-duration",
    turnId,
    type,
    timestamp: new Date(timestampMs),
    traceId: "trace-1",
    sequenceNumber: seq,
    payload,
  } as unknown as SessionEvent;
}

function startRunningTurn(projection: ProductProjection): void {
  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "hi", executionKind: "agent" },
      T0,
    ),
  );
}

function reasoningEvent(
  kind: "reasoning_start" | "reasoning_delta" | "reasoning_end",
  timestampMs: number,
  extra: Record<string, unknown> = {},
): SessionEvent {
  return makeEvent(
    SessionEventType.ModelStreaming,
    { kind, delta: "", done: false, ...extra },
    timestampMs,
  );
}

function reasoningRows(projection: ProductProjection): ReasoningRow[] {
  return projection
    .getSnapshot()
    .rows.window.filter((row): row is ReasoningRow => row.kind === "reasoning");
}

test("reasoning_end 闭合时写入真实 durationMs（起点=开行事件时间，终点=闭合事件时间）", () => {
  const projection = new ProductProjection("sess-reasoning-duration", "epoch-1");
  startRunningTurn(projection);

  projection.applyEvent(
    reasoningEvent("reasoning_start", T0 + 1_000, {
      assistantMessageId: "msg-1",
      partId: "part-1",
    }),
  );
  projection.applyEvent(
    reasoningEvent("reasoning_delta", T0 + 2_000, { partId: "part-1", delta: "思考中" }),
  );
  projection.applyEvent(reasoningEvent("reasoning_end", T0 + 6_000, { partId: "part-1" }));

  const rows = reasoningRows(projection);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.state, "complete");
  assert.equal(rows[0]?.durationMs, 5_000);
});

test("回合被取消时，未闭合的思考行以闭合事件时间为终点写入 durationMs", () => {
  const projection = new ProductProjection("sess-reasoning-duration", "epoch-1");
  startRunningTurn(projection);

  projection.applyEvent(
    reasoningEvent("reasoning_start", T0 + 1_000, {
      assistantMessageId: "msg-1",
      partId: "part-1",
    }),
  );
  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnComplete,
      {
        response: "",
        tokenCount: 0,
        toolCallCount: 0,
        duration: 4_000,
        resultType: "cancelled",
      },
      T0 + 5_000,
    ),
  );

  const rows = reasoningRows(projection);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.state, "interrupted");
  assert.equal(rows[0]?.durationMs, 4_000);
});

test("同一 response 的连续思考分片复用同一行：文本拼接、耗时覆盖整段", () => {
  const projection = new ProductProjection("sess-reasoning-duration", "epoch-1");
  startRunningTurn(projection);

  // 同一 assistantMessageId 下 Responses 每个 summary part 走一遍 start→delta→end；
  // 直播必须收敛成一行，与落库归并后的一条 part 一致。
  projection.applyEvent(
    reasoningEvent("reasoning_start", T0 + 1_000, {
      assistantMessageId: "msg-1",
      partId: "part-1",
    }),
  );
  projection.applyEvent(
    reasoningEvent("reasoning_delta", T0 + 2_000, {
      assistantMessageId: "msg-1",
      partId: "part-1",
      delta: "第一段",
    }),
  );
  projection.applyEvent(
    reasoningEvent("reasoning_end", T0 + 3_000, {
      assistantMessageId: "msg-1",
      partId: "part-1",
    }),
  );
  projection.applyEvent(
    reasoningEvent("reasoning_start", T0 + 3_100, {
      assistantMessageId: "msg-1",
      partId: "part-2",
    }),
  );
  projection.applyEvent(
    reasoningEvent("reasoning_delta", T0 + 4_000, {
      assistantMessageId: "msg-1",
      partId: "part-2",
      delta: "第二段",
    }),
  );
  projection.applyEvent(
    reasoningEvent("reasoning_end", T0 + 6_000, {
      assistantMessageId: "msg-1",
      partId: "part-2",
    }),
  );

  const rows = reasoningRows(projection);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.state, "complete");
  assert.equal(rows[0]?.text, "第一段第二段");
  // 耗时窗口从第一片开行算到最后闭合（与落库归并的 min/max 窗口同量）。
  assert.equal(rows[0]?.durationMs, 5_000);
});

test("不同 response 的思考不复用：仍各自独立成行", () => {
  const projection = new ProductProjection("sess-reasoning-duration", "epoch-1");
  startRunningTurn(projection);

  projection.applyEvent(
    reasoningEvent("reasoning_start", T0 + 1_000, {
      assistantMessageId: "msg-1",
      partId: "part-1",
    }),
  );
  projection.applyEvent(
    reasoningEvent("reasoning_delta", T0 + 2_000, {
      assistantMessageId: "msg-1",
      partId: "part-1",
      delta: "A",
    }),
  );
  projection.applyEvent(
    reasoningEvent("reasoning_end", T0 + 3_000, {
      assistantMessageId: "msg-1",
      partId: "part-1",
    }),
  );
  projection.applyEvent(
    reasoningEvent("reasoning_start", T0 + 3_100, {
      assistantMessageId: "msg-2",
      partId: "part-2",
    }),
  );
  projection.applyEvent(
    reasoningEvent("reasoning_delta", T0 + 4_000, {
      assistantMessageId: "msg-2",
      partId: "part-2",
      delta: "B",
    }),
  );
  projection.applyEvent(
    reasoningEvent("reasoning_end", T0 + 5_000, {
      assistantMessageId: "msg-2",
      partId: "part-2",
    }),
  );

  const rows = reasoningRows(projection);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => [row.state, row.text, row.durationMs]),
    [
      ["complete", "A", 2_000],
      ["complete", "B", 1_900],
    ],
  );
});

test("工具行隔开的两段思考不复用：中间有真实边界即新开行", () => {
  const projection = new ProductProjection("sess-reasoning-duration", "epoch-1");
  startRunningTurn(projection);

  projection.applyEvent(
    reasoningEvent("reasoning_start", T0 + 1_000, {
      assistantMessageId: "msg-1",
      partId: "part-1",
    }),
  );
  projection.applyEvent(
    reasoningEvent("reasoning_end", T0 + 2_000, {
      assistantMessageId: "msg-1",
      partId: "part-1",
    }),
  );
  projection.applyEvent(
    makeEvent(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "call-1",
        toolName: "Bash",
        input: { command: "ls" },
        assistantMessageId: "msg-1",
      },
      T0 + 2_500,
    ),
  );
  projection.applyEvent(
    reasoningEvent("reasoning_start", T0 + 3_000, {
      assistantMessageId: "msg-1",
      partId: "part-2",
    }),
  );
  projection.applyEvent(
    reasoningEvent("reasoning_end", T0 + 4_000, {
      assistantMessageId: "msg-1",
      partId: "part-2",
    }),
  );

  const rows = reasoningRows(projection);
  assert.equal(rows.length, 2);
});
