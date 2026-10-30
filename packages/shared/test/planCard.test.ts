import assert from "node:assert/strict";
import test from "node:test";
import type {
  AssistantTextRow,
  ConversationRow,
  ReasoningRow,
  ToolCallRow,
  TurnHeaderRow,
} from "../src/zcode-protocol-v4/rows.js";
import {
  hasPlanCardInLastAssistantResponse,
  isPlanCardToolCallRow,
  resolveLastAssistantResponseId,
} from "../src/zcode-protocol-v4/plan-card.js";

const TURN_ID = "turn-plan-card";

function turnHeader(rowId: number): TurnHeaderRow {
  return {
    kind: "turnHeader",
    rowId,
    turnId: TURN_ID,
    createdAt: rowId,
    createdAtSeq: rowId,
    origin: "userInput",
    executionKind: "agent",
    state: "completedSuccess",
    startedAt: rowId,
  };
}

function toolRow(
  rowId: number,
  toolName: string,
  input?: unknown,
  responseId?: string,
  overrides: Partial<ToolCallRow> = {},
): ToolCallRow {
  return {
    kind: "toolCall",
    rowId,
    turnId: TURN_ID,
    createdAt: rowId,
    createdAtSeq: rowId,
    toolCallId: `call-${rowId}`,
    toolName,
    status: "success",
    inputText: "",
    ...(input === undefined ? {} : { input }),
    ...(responseId === undefined ? {} : { assistantResponseId: responseId }),
    ...overrides,
  };
}

function planRow(
  rowId: number,
  responseId?: string,
  options: { toolName?: string; input?: unknown; overrides?: Partial<ToolCallRow> } = {},
): ToolCallRow {
  return toolRow(
    rowId,
    options.toolName ?? "CreatePlan",
    options.input ?? { title: "标题", overview: "概述", plan: "# 计划" },
    responseId,
    options.overrides,
  );
}

function textRow(rowId: number, responseId?: string, text = "答复"): AssistantTextRow {
  return {
    kind: "assistantText",
    rowId,
    turnId: TURN_ID,
    createdAt: rowId,
    createdAtSeq: rowId,
    text,
    state: "complete",
    ...(responseId === undefined ? {} : { assistantResponseId: responseId }),
  };
}

function reasoningRow(rowId: number, responseId?: string): ReasoningRow {
  return {
    kind: "reasoning",
    rowId,
    turnId: TURN_ID,
    createdAt: rowId,
    createdAtSeq: rowId,
    text: "思考",
    state: "complete",
    ...(responseId === undefined ? {} : { assistantResponseId: responseId }),
  };
}

test("最后一次响应里的有效计划卡命中", () => {
  assert.equal(
    hasPlanCardInLastAssistantResponse([
      turnHeader(1),
      planRow(2, "resp-plan"),
      textRow(3, "resp-plan"),
    ]),
    true,
  );
});

test("历史 ExitPlanMode 有效兼容", () => {
  assert.equal(
    hasPlanCardInLastAssistantResponse([
      turnHeader(1),
      planRow(2, "resp-plan", { toolName: "ExitPlanMode" }),
    ]),
    true,
  );
});

test("早期响应的计划卡被后续 reasoning / tool / text 接续：不命中", () => {
  const rows: ConversationRow[] = [
    turnHeader(1),
    planRow(2, "resp-early"),
    reasoningRow(3, "resp-next"),
    toolRow(4, "Read", { file_path: "/repo/a.ts" }, "resp-next"),
    textRow(5, "resp-next"),
  ];
  assert.equal(hasPlanCardInLastAssistantResponse(rows), false);
});

test("新 product turn 里没有计划卡：旧描边清除", () => {
  const rows: ConversationRow[] = [
    turnHeader(1),
    planRow(2, "resp-plan"),
    turnHeader(3),
    textRow(4, "resp-next"),
  ];
  assert.equal(hasPlanCardInLastAssistantResponse(rows), false);
});

test("失败的计划工具即使内容在场也不命中", () => {
  assert.equal(
    hasPlanCardInLastAssistantResponse([
      turnHeader(1),
      planRow(2, "resp-plan", {
        overrides: {
          status: "error",
          error: { code: "fault.runtime.toolFailed", message: "boom" },
        },
      }),
    ]),
    false,
  );
});

test("没有 title / overview / plan 的程序计划工具不命中", () => {
  assert.equal(
    hasPlanCardInLastAssistantResponse([turnHeader(1), planRow(2, "resp-plan", { input: {} })]),
    false,
  );
});

test("只有 planFilePath 不算内容：磁盘计划文件不是描边依据", () => {
  assert.equal(
    hasPlanCardInLastAssistantResponse([
      turnHeader(1),
      planRow(2, "resp-plan", {
        input: {},
        overrides: { planFilePath: "/repo/.zcode/plans/plan-1.md" },
      }),
    ]),
    false,
  );
});

test("流式合法半成卡（title/overview 已在 inputText）命中", () => {
  assert.equal(
    isPlanCardToolCallRow(
      planRow(2, "resp-plan", {
        input: undefined,
        overrides: {
          status: "inputStreaming",
          inputText: '{"title":"标题","overview":"概述","plan":"# 计',
        },
      }),
    ),
    true,
  );
});

test("历史拒绝行（status=error、无 permissionDenial、input 有计划内容）命中", () => {
  assert.equal(
    isPlanCardToolCallRow(
      planRow(2, "resp-plan", {
        toolName: "ExitPlanMode",
        overrides: {
          status: "error",
          error: {
            code: "fault.runtime.toolFailed",
            message: "Permission denied for ExitPlanMode",
          },
          output: { text: "Permission denied for ExitPlanMode" },
        },
      }),
    ),
    true,
  );
});

test("系统入参校验失败不按历史拒绝兼容：不命中", () => {
  assert.equal(
    isPlanCardToolCallRow(
      planRow(2, "resp-plan", {
        toolName: "ExitPlanMode",
        input: { title: "标题", overview: "概述" },
        overrides: {
          status: "error",
          error: { code: "tool_execution_failed", message: "InputValidationError: plan missing" },
          output: { text: "Tool input failed inputSchema validation" },
        },
      }),
    ),
    false,
  );
});

test("缺 assistantResponseId 时保守判否", () => {
  assert.equal(hasPlanCardInLastAssistantResponse([turnHeader(1), planRow(2)]), false);
  assert.equal(resolveLastAssistantResponseId([turnHeader(1), planRow(2)]), undefined);
});

test("裁剪窗口缺 turnHeader 时判否", () => {
  assert.equal(hasPlanCardInLastAssistantResponse([planRow(2, "resp-plan")]), false);
});

test("resolveLastAssistantResponseId 跳过已拆出的轮尾行", () => {
  const tail = textRow(3);
  assert.equal(
    resolveLastAssistantResponseId([planRow(2, "resp-plan"), tail], {
      ignoredRowIds: new Set([tail.rowId]),
    }),
    "resp-plan",
  );
});

test("用户批准不改行：同一份行反复派生结果一致", () => {
  const rows: ConversationRow[] = [turnHeader(1), planRow(2, "resp-plan")];
  assert.equal(hasPlanCardInLastAssistantResponse(rows), true);
  assert.equal(hasPlanCardInLastAssistantResponse(rows), true);
});

test("status=error 且 permissionDenial 在场：计划批准拒绝不是失败（异常/历史快照保守边界）", () => {
  assert.equal(
    isPlanCardToolCallRow(
      planRow(2, "resp-plan", {
        overrides: {
          status: "error",
          permissionDenial: { decision: "deny", reason: "plan denied" },
          error: { code: "fault.runtime.toolFailed", message: "Permission denied" },
        },
      }),
    ),
    true,
  );
});

test("status=cancelled 但残留 error.message：按失败处理，与正文一致", () => {
  assert.equal(
    isPlanCardToolCallRow(
      planRow(2, "resp-plan", {
        overrides: {
          status: "cancelled",
          error: { code: "fault.runtime.toolFailed", message: "execution failed" },
        },
      }),
    ),
    false,
  );
});

test("空的 text_start 占位仍属于新响应：锚点移动，旧计划卡不命中", () => {
  const rows: ConversationRow[] = [
    turnHeader(1),
    planRow(2, "resp-plan"),
    textRow(3, "resp-followup", ""),
  ];
  assert.equal(resolveLastAssistantResponseId(rows), "resp-followup");
  assert.equal(hasPlanCardInLastAssistantResponse(rows), false);
});

test("EnterPlanMode 工具行也移动响应锚点，即使它不渲染计划卡", () => {
  const rows: ConversationRow[] = [
    turnHeader(1),
    planRow(2, "resp-plan"),
    toolRow(3, "EnterPlanMode", {}, "resp-followup"),
  ];
  assert.equal(resolveLastAssistantResponseId(rows), "resp-followup");
  assert.equal(hasPlanCardInLastAssistantResponse(rows), false);
});
