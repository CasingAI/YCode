import assert from "node:assert/strict";
import test from "node:test";
import {
  hasPlanCardInLastAssistantResponse,
  isPlanCardToolCallRow as isSharedPlanCardToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  AssistantTextRow,
  ConversationRow,
  ReasoningRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { buildConversationTurnRenderUnitFrame } from "../src/v4/conversationTurnRenderUnits.js";
import { isPlanCardToolCallRow } from "../src/v4/conversationTurnFlowItems.js";

// 正文脱流与 sessions-index 摘要必须对同一行给同一答案。这个矩阵不是为了复测内容提取，
// 而是钉住 UI 的 `isPlanCardToolCallRow` 不再自己维护第二套工具身份/失败/流式语义。
function planRow(overrides: Partial<ToolCallRow> = {}): ToolCallRow {
  return {
    kind: "toolCall",
    rowId: 2,
    turnId: "turn-1",
    createdAt: 2,
    createdAtSeq: 2,
    toolCallId: "call-plan",
    toolName: "CreatePlan",
    status: "success",
    inputText: "",
    input: { title: "标题", overview: "概述", plan: "# 计划" },
    assistantResponseId: "resp-plan",
    ...overrides,
  };
}

function assertSameDecision(row: ToolCallRow, expected: boolean): void {
  assert.equal(isSharedPlanCardToolCallRow(row), expected, `shared: ${row.toolCallId}`);
  assert.equal(isPlanCardToolCallRow(row), expected, `ui: ${row.toolCallId}`);
}

test("UI 与 shared 对计划卡行矩阵给同一结论", () => {
  assertSameDecision(planRow(), true);
  assertSameDecision(planRow({ toolName: "ExitPlanMode" }), true);
  assertSameDecision(
    planRow({ status: "error", error: { code: "fault.runtime.toolFailed", message: "boom" } }),
    false,
  );
  assertSameDecision(planRow({ input: {} }), false);
  assertSameDecision(
    planRow({
      toolName: "ExitPlanMode",
      status: "error",
      error: { code: "fault.runtime.toolFailed", message: "Permission denied for ExitPlanMode" },
      output: { text: "Permission denied for ExitPlanMode" },
    }),
    true,
  );
  assertSameDecision(
    planRow({
      input: { title: "标题", overview: "概述" },
      status: "error",
      error: { code: "tool_execution_failed", message: "InputValidationError" },
      output: { text: "Tool input failed inputSchema validation" },
    }),
    false,
  );
  assertSameDecision(
    planRow({
      status: "inputStreaming",
      input: undefined,
      inputText: '{"title":"标题","overview":"概述","plan":"# 计',
    }),
    true,
  );
  assertSameDecision(planRow({ input: {}, planFilePath: "/repo/.zcode/plans/a.md" }), false);
  assertSameDecision(planRow({ toolName: "TodoWrite" }), false);
  assertSameDecision(
    planRow({
      status: "cancelled",
      permissionDenial: { decision: "deny", reason: "plan denied" },
    }),
    true,
  );
});

test("异常快照矩阵：adapter 的失败语义与 shared 判据一致", async () => {
  const { toolCallRowToLegacyNode } = await import("../src/v4/toolCallRowAdapter.js");
  const { extractPlanToolCallContent } = await import("../src/lib/planToolCall.js");

  const errorWithDenial = planRow({
    status: "error",
    permissionDenial: { decision: "deny", reason: "plan denied" },
    error: { code: "fault.runtime.toolFailed", message: "Permission denied" },
  });
  assertSameDecision(errorWithDenial, true);
  const deniedNode = toolCallRowToLegacyNode(errorWithDenial);
  assert.equal(deniedNode.toolCall.status, "stopped");
  assert.equal(deniedNode.toolCall.error, undefined);
  assert.ok(extractPlanToolCallContent(deniedNode.toolCall, "/repo").markdown);

  const cancelledWithError = planRow({
    status: "cancelled",
    error: { code: "fault.runtime.toolFailed", message: "execution failed" },
  });
  assertSameDecision(cancelledWithError, false);
  const cancelledNode = toolCallRowToLegacyNode(cancelledWithError);
  assert.equal(cancelledNode.toolCall.status, "stopped");
  assert.equal(cancelledNode.toolCall.error, "execution failed");
  assert.deepEqual(extractPlanToolCallContent(cancelledNode.toolCall, "/repo"), {});
});

test("v4 output-only / 空入参 / path-only 的 extract 与真实渲染判据同向", async () => {
  const { toolCallRowToLegacyNode } = await import("../src/v4/toolCallRowAdapter.js");
  const { extractPlanToolCallContent, shouldRenderCollapsedPlanCard } =
    await import("../src/lib/planToolCall.js");

  const assertDecision = (row: ToolCallRow, expected: boolean): void => {
    assertSameDecision(row, expected);
    const node = toolCallRowToLegacyNode(row);
    const content = extractPlanToolCallContent(node.toolCall, "/repo");
    assert.equal(
      shouldRenderCollapsedPlanCard({
        hasMarkdown: content.markdown !== undefined,
        hasTitleOrOverview: content.title !== undefined || content.overview !== undefined,
        overview: content.overview,
        streaming: row.status === "inputStreaming",
      }),
      expected,
      `renderer: ${row.toolCallId}`,
    );
  };

  assertDecision(
    planRow({
      input: undefined,
      inputText: "",
      output: { text: "# 旧计划" },
    }),
    false,
  );
  assertDecision(
    planRow({
      input: {},
      inputText: "   ",
      output: { text: "ok" },
    }),
    false,
  );
  assertDecision(
    planRow({
      input: {},
      inputText: "",
      planFilePath: "/repo/.zcode/plans/a.md",
    }),
    false,
  );
  // 定稿 title-only 旧行：shared 与渲染器都认作折叠卡。
  assertDecision(planRow({ input: { title: "旧计划标题" } }), true);
  assertDecision(
    planRow({
      toolName: "ExitPlanMode",
      status: "error",
      input: { title: "旧拒绝标题" },
      error: { code: "fault.runtime.toolFailed", message: "Permission denied for ExitPlanMode" },
      output: { text: "Permission denied for ExitPlanMode" },
    }),
    true,
  );
});

function turnHeaderRow(): TurnHeaderRow {
  return {
    kind: "turnHeader",
    rowId: 1,
    turnId: "turn-1",
    origin: "userInput",
    executionKind: "agent",
    state: "completedSuccess",
    startedAt: 1,
    endedAt: 2,
    createdAt: 1,
    createdAtSeq: 1,
  };
}

function userInputRow(): UserInputRow {
  return {
    kind: "userInput",
    rowId: 2,
    turnId: "turn-1",
    createdAt: 2,
    createdAtSeq: 2,
    text: "写计划",
    origin: "realUser",
  };
}

function textRow(rowId: number, assistantResponseId: string, text: string): AssistantTextRow {
  return {
    kind: "assistantText",
    rowId,
    turnId: "turn-1",
    createdAt: rowId,
    createdAtSeq: rowId,
    text,
    state: "complete",
    assistantResponseId,
  };
}

function reasoningRow(rowId: number, assistantResponseId: string, text: string): ReasoningRow {
  return {
    kind: "reasoning",
    rowId,
    turnId: "turn-1",
    createdAt: rowId,
    createdAtSeq: rowId,
    text,
    state: "complete",
    assistantResponseId,
  };
}

function enterPlanModeRow(rowId: number, assistantResponseId: string): ToolCallRow {
  return planRow({
    rowId,
    createdAt: rowId,
    createdAtSeq: rowId,
    toolCallId: `call-${rowId}`,
    toolName: "EnterPlanMode",
    input: {},
    assistantResponseId,
  });
}

function planFlowKinds(rows: readonly ConversationRow[]): string[] {
  const frame = buildConversationTurnRenderUnitFrame(rows, { nowMs: 3_000 });
  const unit = frame.entries[0]?.unit;
  assert.ok(unit, "应生成一个 render unit");
  return unit.flowItems.map((item) => item.kind);
}

test("renderUnitFrame 级：后续新 response 一开始就清除旧计划卡（含被过滤的占位行）", () => {
  // 计划响应里计划行后面还有同 response 的正文，旧实现只看过滤后的行：
  // 新 response 的空占位被裁掉后，锚点退回计划 response，计划卡被误当成
  // 「最后一次响应」脱流到段末，而侧栏摘要已判无卡。EnterPlanMode 现在按普通
  // 工具行保留，但它同样属于新 response，不能让旧计划卡继续脱流。
  const planResponseTail = textRow(4, "resp-plan", "计划已提交");
  const cases: Array<{ label: string; followup: ConversationRow }> = [
    {
      label: "空 text_start 占位",
      followup: textRow(5, "resp-followup", ""),
    },
    {
      label: "空 reasoning 占位",
      followup: reasoningRow(5, "resp-followup", ""),
    },
    {
      label: "EnterPlanMode 新 response",
      followup: enterPlanModeRow(5, "resp-followup"),
    },
    {
      label: "新的普通 reasoning",
      followup: reasoningRow(5, "resp-followup", "继续思考"),
    },
  ];

  for (const { label, followup } of cases) {
    const rows: ConversationRow[] = [
      turnHeaderRow(),
      userInputRow(),
      planRow({ rowId: 3, createdAt: 3, createdAtSeq: 3, assistantResponseId: "resp-plan" }),
      planResponseTail,
      followup,
    ];
    const kinds = planFlowKinds(rows);
    assert.equal(kinds.includes("planCard"), false, `${label}: 不得脱流成段末计划卡`);
    assert.equal(kinds.includes("planCallRecord"), false, `${label}: 不得留原位调用记录`);
    assert.equal(hasPlanCardInLastAssistantResponse(rows), false, `${label}: 侧栏摘要也不得判有卡`);
  }
});
