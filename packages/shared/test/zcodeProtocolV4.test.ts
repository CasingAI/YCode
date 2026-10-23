import assert from "node:assert/strict";
import test from "node:test";
import {
  subagentRowSchema,
  turnWorkSegmentSchema,
  userInputRowSchema,
  workSegmentUsageSchema,
} from "../src/zcode-protocol-v4/rows.js";
import { commandPayloadSchemas } from "../src/zcode-protocol-v4/command.js";

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

// 单字段用量（断点 A 回归）：不发 reasoning 事件的子代理天然没有推理时长，
// 工具数必须可独立存在；缺席字段保持缺席，不得写成 0。
test("work segment usage fields are independently optional", () => {
  assert.deepEqual(workSegmentUsageSchema.parse({ toolCallCount: 4 }), { toolCallCount: 4 });
  assert.deepEqual(workSegmentUsageSchema.parse({ reasoningDurationMs: 9_000 }), {
    reasoningDurationMs: 9_000,
  });
  assert.deepEqual(workSegmentUsageSchema.parse({}), {});
  // 非法值仍拒绝：可选不等于放宽校验。
  assert.equal(workSegmentUsageSchema.safeParse({ toolCallCount: -1 }).success, false);
  assert.equal(workSegmentUsageSchema.safeParse({ reasoningDurationMs: -1 }).success, false);
});

// editUserQuery 的模型组意图（docs/specs/model-group.md「编辑历史消息的组语义」）：
// 可选携带、与 modelSelection 互斥（与 sendText 同款 superRefine），旧客户端缺省仍合法。
const editUserQueryPayload = {
  target: { rowId: 3, entityId: "entity-3" },
  newText: "改写后的提问",
};

test("editUserQuery 可携带 modelGroupIntent，旧客户端缺省仍合法", () => {
  const parsed = commandPayloadSchemas.editUserQuery.safeParse({
    ...editUserQueryPayload,
    modelGroupIntent: { groupId: "model-group:fast", groupNameSnapshot: "快速模型" },
  });
  assert.equal(parsed.success, true);
  const legacy = commandPayloadSchemas.editUserQuery.safeParse(editUserQueryPayload);
  assert.equal(legacy.success, true);
});

test("editUserQuery 的 modelSelection 与 modelGroupIntent 互斥", () => {
  const both = commandPayloadSchemas.editUserQuery.safeParse({
    ...editUserQueryPayload,
    modelSelection: { providerId: "glm", modelId: "glm-5.3" },
    modelGroupIntent: { groupId: "model-group:fast", groupNameSnapshot: "快速模型" },
  });
  assert.equal(both.success, false);
  // 单独携带具体模型仍然合法（编辑卡改选具体模型的路径）。
  const modelOnly = commandPayloadSchemas.editUserQuery.safeParse({
    ...editUserQueryPayload,
    modelSelection: { providerId: "glm", modelId: "glm-5.3" },
  });
  assert.equal(modelOnly.success, true);
});

// userInput 行投影的组身份（docs/specs/model-group.md）：与 admissionModelSelection
// 分属不同事实层（组身份 / 钉死成员），可并存；旧 snapshot 缺省合法。
test("userInput 行的 admissionModelGroupIntent 可选且与具体模型并存", () => {
  const row = userInputRowSchema.safeParse({
    rowId: 7,
    turnId: "turn-1",
    createdAt: 0,
    createdAtSeq: 1,
    kind: "userInput",
    text: "提问",
    origin: "realUser",
    admissionMode: "yolo",
    admissionModelSelection: { providerId: "glm", modelId: "glm-5.3-flash" },
    admissionModelGroupIntent: { groupId: "model-group:fast", groupNameSnapshot: "快速模型" },
  });
  assert.equal(row.success, true);
  const legacy = userInputRowSchema.safeParse({
    rowId: 7,
    turnId: "turn-1",
    createdAt: 0,
    createdAtSeq: 1,
    kind: "userInput",
    text: "提问",
    origin: "realUser",
  });
  assert.equal(legacy.success, true);
});
