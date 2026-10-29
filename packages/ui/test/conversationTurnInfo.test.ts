import assert from "node:assert/strict";
import test from "node:test";
import { buildConversationTurnInfoFacts } from "../src/v4/conversationTurnInfo.js";
import { buildConversationTurnRenderUnitFrame } from "../src/v4/conversationTurnRenderUnits.js";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTurnWorkSegment } from "../src/v4/conversationTurnWorkSegments.js";

function makeSegment(
  patch: Partial<ConversationTurnWorkSegment> = {},
): ConversationTurnWorkSegment {
  return {
    key: "turn-1",
    flowItems: [],
    assistantWorkRows: [],
    assistantHistoryRows: [],
    assistantFollowingRows: [],
    assistantHistoryDefaultOpen: false,
    workStatus: { state: "completed", durationMs: 54_321 },
    ...patch,
  };
}

test("执行模型按首次顺序透传，同一身份只列一次", () => {
  const facts = buildConversationTurnInfoFacts({
    segment: makeSegment({
      executionModels: [
        { providerId: "cliproxy-codex", modelId: "gpt-6-luna" },
        { providerId: "zhipu", modelId: "glm-5" },
        { providerId: "cliproxy-codex", modelId: "gpt-6-luna" },
      ],
    }),
    turnId: "turn-1",
  });

  assert.deepEqual(facts.executionModels, [
    { providerId: "cliproxy-codex", modelId: "gpt-6-luna" },
    { providerId: "zhipu", modelId: "glm-5" },
  ]);
});

test("不同供应商使用同一模型 ID 时保留两项", () => {
  const facts = buildConversationTurnInfoFacts({
    segment: makeSegment({
      executionModels: [
        { providerId: "provider-a", modelId: "shared-model" },
        { providerId: "provider-b", modelId: "shared-model" },
      ],
    }),
    turnId: "turn-1",
  });

  assert.deepEqual(facts.executionModels, [
    { providerId: "provider-a", modelId: "shared-model" },
    { providerId: "provider-b", modelId: "shared-model" },
  ]);
});

test("身份缺失或字段为空时不从 admission 或 marker 回填", () => {
  const legacySegment = {
    ...makeSegment(),
    triggerRow: {
      admissionModelSelection: { providerId: "current-provider", modelId: "current-model" },
    },
    leadingBoundaryRows: [
      {
        kind: "timelineMarker",
        marker: {
          type: "modelChange",
          toProvider: "marker-provider",
          toModel: "marker-model",
          toThought: "high",
        },
      },
    ],
  } as unknown as ConversationTurnWorkSegment;

  const facts = buildConversationTurnInfoFacts({ segment: legacySegment, turnId: "turn-1" });

  assert.deepEqual(facts.executionModels, []);
});

test("空供应商或空模型的身份不进入展示列表", () => {
  const facts = buildConversationTurnInfoFacts({
    segment: makeSegment({
      executionModels: [
        { providerId: "", modelId: "model-only" },
        { providerId: "provider-only", modelId: "   " },
        { providerId: "provider-a", modelId: "model-a" },
      ],
    }),
    turnId: "turn-1",
  });

  assert.deepEqual(facts.executionModels, [{ providerId: "provider-a", modelId: "model-a" }]);
});

test("明确 0 保持为 0，不写成缺席", () => {
  const facts = buildConversationTurnInfoFacts({
    segment: makeSegment({ usage: { toolCallCount: 0, reasoningDurationMs: 0 } }),
    turnId: "turn-1",
  });

  assert.equal(facts.toolCallCount, 0);
  assert.equal(facts.reasoningDurationMs, 0);
});

test("usage 字段缺席时保持 undefined，不用 0 伪造", () => {
  const facts = buildConversationTurnInfoFacts({
    segment: makeSegment({ usage: {} }),
    turnId: "turn-1",
  });

  assert.equal(facts.toolCallCount, undefined);
  assert.equal(facts.reasoningDurationMs, undefined);
});

test("没有 usage 且工作行为空时保持未知，不把空 fallback 写成 0", () => {
  const facts = buildConversationTurnInfoFacts({
    segment: makeSegment(),
    turnId: "turn-1",
  });

  assert.equal(facts.toolCallCount, undefined);
  assert.equal(facts.reasoningDurationMs, undefined);
});

test("没有权威 usage 时复用旧快照 direct fallback", () => {
  const facts = buildConversationTurnInfoFacts({
    segment: makeSegment({
      assistantWorkRows: [
        { kind: "toolCall" },
        { kind: "reasoning", durationMs: 3_500 },
        { kind: "subagent", usage: { toolCallCount: 2, reasoningDurationMs: 1_000 } },
      ] as ConversationTurnWorkSegment["assistantWorkRows"],
    }),
    turnId: "turn-1",
  });

  assert.equal(facts.toolCallCount, 3);
  assert.equal(facts.reasoningDurationMs, 4_500);
});

test("workStatus 缺席时状态与时长保持未知", () => {
  const facts = buildConversationTurnInfoFacts({
    segment: makeSegment({ workStatus: undefined }),
    turnId: "turn-1",
  });

  assert.equal(facts.workState, undefined);
  assert.equal(facts.durationMs, undefined);
});

test("失败轮的信息状态来自轮头，不显示为成功完成", () => {
  const frame = buildConversationTurnRenderUnitFrame([
    {
      kind: "turnHeader", rowId: 1, turnId: "failed-turn", entityId: "failed-turn",
      createdAt: 100, createdAtSeq: 1, origin: "userInput", executionKind: "agent",
      startedAt: 100, endedAt: 300, state: "failed",
    },
    { kind: "userInput", rowId: 2, turnId: "failed-turn", createdAt: 100,
      createdAtSeq: 2, text: "input", origin: "realUser" },
    { kind: "assistantText", rowId: 3, turnId: "failed-turn", createdAt: 200,
      createdAtSeq: 3, text: "partial", state: "failed" },
  ] as ConversationRow[], { sessionPhase: "error" });
  const unit = frame.entries[0]!.unit;
  const facts = buildConversationTurnInfoFacts({ segment: unit.workSegments![0]!, turnId: unit.turnId });
  assert.equal(facts.workState, "failed");
});

test("turnId 与工作段状态原样透传", () => {
  const facts = buildConversationTurnInfoFacts({
    segment: makeSegment({
      workStatus: { state: "running", durationMs: 2_000 },
    }),
    turnId: "turn-product-9",
  });

  assert.equal(facts.turnId, "turn-product-9");
  assert.equal(facts.workState, "running");
  assert.equal(facts.durationMs, 2_000);
});
