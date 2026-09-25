import assert from "node:assert/strict";
import test from "node:test";
import {
  subagentRowSchema,
  turnWorkSegmentSchema,
  workSegmentUsageSchema,
} from "../src/zcode-protocol-v4/rows.js";

test("work segment usage accepts totals and preserves old rows without usage", () => {
  assert.deepEqual(
    workSegmentUsageSchema.parse({ toolCallCount: 7, reasoningDurationMs: 18_000 }),
    { toolCallCount: 7, reasoningDurationMs: 18_000 },
  );
  assert.deepEqual(turnWorkSegmentSchema.parse({ segmentId: "turn:initial", startedAt: 0 }), {
    segmentId: "turn:initial",
    startedAt: 0,
  });
});

test("work segment usage rejects invalid counts and durations", () => {
  assert.equal(
    workSegmentUsageSchema.safeParse({ toolCallCount: -1, reasoningDurationMs: 0 }).success,
    false,
  );
  assert.equal(
    workSegmentUsageSchema.safeParse({ toolCallCount: 1, reasoningDurationMs: -1 }).success,
    false,
  );
  assert.equal(
    workSegmentUsageSchema.safeParse({ toolCallCount: 1.5, reasoningDurationMs: 0 }).success,
    false,
  );
  // 毫秒取整，与 Agent 工具输出的 totalReasoningDurationMs 口径一致。
  assert.equal(
    workSegmentUsageSchema.safeParse({ toolCallCount: 1, reasoningDurationMs: 1.5 }).success,
    false,
  );
  assert.equal(
    workSegmentUsageSchema.safeParse({
      toolCallCount: 1,
      reasoningDurationMs: Number.POSITIVE_INFINITY,
    }).success,
    false,
  );
});

test("subagent usage is optional for legacy rows", () => {
  const row = subagentRowSchema.parse({
    rowId: 1,
    turnId: "turn-1",
    kind: "subagent",
    subagentType: "Explore",
    status: "success",
    summaryText: "done",
    createdAt: 0,
    createdAtSeq: 1,
  });
  assert.equal(row.usage, undefined);
});
