// 侧栏计划卡描边的回归：描边只认「最后一个 product turn 的最后一次 assistant response
// 里有一张默认展示的有效计划卡」。这里从真实事件驱动 ProductProjection，再走
// sessions-index 派生，钉住用户报告的错描边（旧 ExitPlanMode 批准后同轮继续实施）。
import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { SessionsIndexProjection } from "../src/zcode-protocol-v4/sessions-index-projection.js";
import { SessionsIndexPublisher } from "../src/zcode-protocol-v4/sessions-index-publisher.js";

const WORKSPACE_ID = "/repo";
const SESSION_ID = "session-index-plan-ring";
const TURN_ID = "turn-index-plan-ring";
const T0 = 1_700_000_000_000;

let sequenceNumber = 0;
function event(type: SessionEventType, payload: unknown, offsetMs: number): SessionEvent {
  sequenceNumber += 1;
  return {
    id: `event-${sequenceNumber}`,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    type,
    timestamp: new Date(T0 + offsetMs),
    traceId: "trace-index-plan-ring",
    sequenceNumber,
    payload,
  } as unknown as SessionEvent;
}

function startTurn(projection: ProductProjection, turnNumber: number, offsetMs: number): void {
  projection.applyEvent(
    event(
      SessionEventType.TurnStarted,
      { turnNumber, input: "开始", executionKind: "agent" },
      offsetMs,
    ),
  );
}

function schedulePlan(
  projection: ProductProjection,
  options: {
    toolCallId: string;
    assistantMessageId?: string;
    toolName?: string;
    input: unknown;
    offsetMs: number;
  },
): void {
  const toolName = options.toolName ?? "CreatePlan";
  projection.applyEvent(
    event(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: options.toolCallId,
        ...(options.assistantMessageId
          ? { assistantMessageId: options.assistantMessageId }
          : {}),
        toolName,
        input: options.input,
        schedule: {
          parallelGroups: [[options.toolCallId]],
          executionOrder: [options.toolCallId],
        },
      },
      options.offsetMs,
    ),
  );
}

function completeTool(
  projection: ProductProjection,
  toolCallId: string,
  success: boolean,
  offsetMs: number,
): void {
  projection.applyEvent(
    event(
      success ? SessionEventType.ToolCallResult : SessionEventType.ToolCallError,
      success
        ? {
            toolCallId,
            result: { success: true, content: "ok" },
            duration: 1,
          }
        : {
            toolCallId,
            error: { type: "tool_execution_failed", message: "plan tool failed" },
          },
      offsetMs,
    ),
  );
}

/** 同一条 product turn 内开启一次新的模型响应（正文流）。 */
function startAssistantText(
  projection: ProductProjection,
  assistantMessageId: string,
  text: string,
  offsetMs: number,
): void {
  const partId = `part-${assistantMessageId}`;
  projection.applyEvent(
    event(
      SessionEventType.ModelStreaming,
      { kind: "text_start", assistantMessageId, partId },
      offsetMs,
    ),
  );
  projection.applyEvent(
    event(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", assistantMessageId, partId, delta: text },
      offsetMs + 1,
    ),
  );
}

function eventsThroughTurnComplete(
  projection: ProductProjection,
  offsetMs: number,
): void {
  projection.applyEvent(
    event(
      SessionEventType.TurnComplete,
      { response: "", toolCallCount: 1, historyRoundCount: 1, duration: 2_000 },
      offsetMs,
    ),
  );
}

function summaryOf(
  deltas: ReturnType<SessionsIndexProjection["upsertFromConversation"]>,
): SessionSummary | undefined {
  return deltas
    .flatMap((delta) => (delta.op === "session.upserted" ? [delta.session] : []))
    .find((summary) => summary.sessionId === SESSION_ID);
}

function derive(
  index: SessionsIndexProjection,
  projection: ProductProjection,
  lastActivityAt = T0,
): SessionSummary | undefined {
  return summaryOf(
    index.upsertFromConversation(projection.getSnapshot(), {
      createdAt: T0,
      lastActivityAt,
    }),
  );
}

test("最后一次响应里的有效 CreatePlan：保留描边", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-ring-1");
  startTurn(projection, 1, 0);
  schedulePlan(projection, {
    toolCallId: "call-plan",
    assistantMessageId: "assistant-plan",
    input: { title: "标题", overview: "概述", plan: "# 计划" },
    offsetMs: 1_000,
  });
  completeTool(projection, "call-plan", true, 1_500);

  const summary = derive(new SessionsIndexProjection(WORKSPACE_ID, "epoch"), projection);
  assert.equal(summary?.lastTurnHasPlanCard, true);
});

test("同轮后续响应只有正文：计划卡不再是默认展示，描边立即重新派生清除", () => {
  // 用户报告形态：旧 ExitPlanMode 批准完成、随后同一条 product turn 里继续实施并总结。
  const projection = new ProductProjection(SESSION_ID, "epoch-ring-2");
  startTurn(projection, 1, 0);
  schedulePlan(projection, {
    toolCallId: "call-exit-plan",
    assistantMessageId: "assistant-plan",
    toolName: "ExitPlanMode",
    input: { title: "标题", overview: "概述", plan: "# 计划" },
    offsetMs: 1_000,
  });
  completeTool(projection, "call-exit-plan", true, 1_500);
  startAssistantText(projection, "assistant-implementation", "开始实施", 2_000);
  completeTool(projection, "call-exit-plan", true, 2_500);

  const summary = derive(new SessionsIndexProjection(WORKSPACE_ID, "epoch"), projection);
  assert.equal(summary?.lastTurnHasPlanCard, undefined);
});

test("同轮后续响应只有工具调用：不必等最终总结，描边已经清除", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-ring-3");
  startTurn(projection, 1, 0);
  schedulePlan(projection, {
    toolCallId: "call-plan",
    assistantMessageId: "assistant-plan",
    input: { plan: "# 计划" },
    offsetMs: 1_000,
  });
  projection.applyEvent(
    event(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "call-impl",
        assistantMessageId: "assistant-implementation",
        toolName: "Read",
        input: { file_path: "/repo/a.ts" },
        schedule: { parallelGroups: [["call-impl"]], executionOrder: ["call-impl"] },
      },
      2_000,
    ),
  );

  const summary = derive(new SessionsIndexProjection(WORKSPACE_ID, "epoch"), projection);
  assert.equal(summary?.lastTurnHasPlanCard, undefined);
});

test("失败的计划工具即使 input 有内容也不描边", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-ring-4");
  startTurn(projection, 1, 0);
  schedulePlan(projection, {
    toolCallId: "call-plan",
    assistantMessageId: "assistant-plan",
    input: { title: "标题", overview: "概述", plan: "# 计划" },
    offsetMs: 1_000,
  });
  completeTool(projection, "call-plan", false, 1_500);

  const summary = derive(new SessionsIndexProjection(WORKSPACE_ID, "epoch"), projection);
  assert.equal(summary?.lastTurnHasPlanCard, undefined);
});

test("没有 title/overview/plan 的程序计划工具不算有效计划卡", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-ring-5");
  startTurn(projection, 1, 0);
  schedulePlan(projection, {
    toolCallId: "call-plan",
    assistantMessageId: "assistant-plan",
    input: {},
    offsetMs: 1_000,
  });
  completeTool(projection, "call-plan", true, 1_500);

  const summary = derive(new SessionsIndexProjection(WORKSPACE_ID, "epoch"), projection);
  assert.equal(summary?.lastTurnHasPlanCard, undefined);
});

test("只有 planFilePath 没有行内容：磁盘计划文件不作为描边依据", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-ring-6");
  startTurn(projection, 1, 0);
  schedulePlan(projection, {
    toolCallId: "call-plan",
    assistantMessageId: "assistant-plan",
    input: {},
    offsetMs: 1_000,
  });
  projection.applyEvent(
    event(
      SessionEventType.PlanFileWritten,
      { planId: "plan-1", planFilePath: "/repo/.zcode/plans/plan-1.md", toolCallId: "call-plan" },
      1_500,
    ),
  );
  completeTool(projection, "call-plan", true, 1_800);

  const summary = derive(new SessionsIndexProjection(WORKSPACE_ID, "epoch"), projection);
  assert.equal(summary?.lastTurnHasPlanCard, undefined);
});

test("缺 assistantResponseId 时保守不算：证不出属于最后一次响应", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-ring-7");
  startTurn(projection, 1, 0);
  schedulePlan(projection, {
    toolCallId: "call-plan",
    input: { plan: "# 计划" },
    offsetMs: 1_000,
  });

  const summary = derive(new SessionsIndexProjection(WORKSPACE_ID, "epoch"), projection);
  assert.equal(summary?.lastTurnHasPlanCard, undefined);
});

test("流式半成卡（只有 title/overview 的 inputText）仍算有效计划卡", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-ring-8");
  startTurn(projection, 1, 0);
  projection.applyEvent(
    event(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_start",
        toolCallId: "call-plan",
        assistantMessageId: "assistant-plan",
        toolName: "CreatePlan",
      },
      1_000,
    ),
  );
  projection.applyEvent(
    event(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_delta",
        toolCallId: "call-plan",
        assistantMessageId: "assistant-plan",
        delta: '{"title":"标题","overview":"概述","plan":"# 计',
      },
      1_100,
    ),
  );

  const rows = projection.getSnapshot().rows.window;
  const planRow = rows.find((row) => row.kind === "toolCall");
  assert.equal(planRow?.kind === "toolCall" && planRow.status, "inputStreaming");
  assert.equal(planRow?.kind === "toolCall" && planRow.assistantResponseId, "assistant-plan");

  const summary = derive(new SessionsIndexProjection(WORKSPACE_ID, "epoch"), projection);
  assert.equal(summary?.lastTurnHasPlanCard, true);
});

test("旧 ExitPlanMode 批准完成且属于最后一次响应：继续兼容描边", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-ring-9");
  startTurn(projection, 1, 0);
  schedulePlan(projection, {
    toolCallId: "call-exit-plan",
    assistantMessageId: "assistant-plan",
    toolName: "ExitPlanMode",
    input: { title: "标题", overview: "概述", plan: "# 计划" },
    offsetMs: 1_000,
  });
  completeTool(projection, "call-exit-plan", true, 1_500);
  eventsThroughTurnComplete(projection, 2_000);

  const summary = derive(new SessionsIndexProjection(WORKSPACE_ID, "epoch"), projection);
  assert.equal(summary?.lastTurnHasPlanCard, true);
});

test("描边从 true 翻到 false 必须产帧（同一 phase 下 conflation 不得吞掉）", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-ring-10");
  startTurn(projection, 1, 0);
  schedulePlan(projection, {
    toolCallId: "call-plan",
    assistantMessageId: "assistant-plan",
    input: { plan: "# 计划" },
    offsetMs: 1_000,
  });

  const publisher = new SessionsIndexPublisher(WORKSPACE_ID, "index-epoch", () => T0);
  const subscribed = publisher.subscribeReserved("connection-1");
  assert.equal(subscribed.reservation?.commit(), true);
  const subscriptionId = subscribed.subscriptionId;

  assert.equal(
    publisher.ingestConversation(projection.getSnapshot(), {
      createdAt: T0,
      lastActivityAt: T0,
    }),
    true,
  );
  const withRing = publisher.reserveFlush(subscriptionId);
  assert.ok(withRing);
  const firstUpserts = withRing.frame.payload.kind === "snapshot"
    ? []
    : withRing.frame.payload.deltas.filter(
        (delta) => delta.op === "session.upserted" && delta.session.sessionId === SESSION_ID,
      );
  if (withRing.frame.payload.kind === "snapshot") {
    assert.equal(
      withRing.frame.payload.snapshot.sessions.find((s) => s.sessionId === SESSION_ID)
        ?.lastTurnHasPlanCard,
      true,
    );
  } else {
    assert.equal(firstUpserts.at(-1)?.session.lastTurnHasPlanCard, true);
  }
  assert.equal(withRing.commit(), true);

  // 后一次模型响应开始：同一 phase、同一轮，只有描边字段翻转，仍必须产帧。
  startAssistantText(projection, "assistant-implementation", "实施中", 2_000);
  assert.equal(
    publisher.ingestConversation(projection.getSnapshot(), {
      createdAt: T0,
      lastActivityAt: T0 + 2_000,
    }),
    true,
  );
  const withoutRing = publisher.reserveFlush(subscriptionId);
  assert.ok(withoutRing, "描边清除必须产帧，否则列表停在旧描边");
  const clearedUpserts = withoutRing.frame.payload.kind === "snapshot"
    ? []
    : withoutRing.frame.payload.deltas.filter(
        (delta) => delta.op === "session.upserted" && delta.session.sessionId === SESSION_ID,
      );
  if (withoutRing.frame.payload.kind === "snapshot") {
    assert.equal(
      withoutRing.frame.payload.snapshot.sessions.find((s) => s.sessionId === SESSION_ID)
        ?.lastTurnHasPlanCard,
      undefined,
    );
  } else {
    assert.equal(clearedUpserts.at(-1)?.session.lastTurnHasPlanCard, undefined);
  }
  assert.equal(withoutRing.commit(), true);
});

test("reasoning_phase_start 用 assistantMessageId 作响应身份，provider responseId 不冒充", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-ring-phase-1");
  startTurn(projection, 1, 0);
  projection.applyEvent(
    event(
      SessionEventType.ModelStreaming,
      {
        kind: "reasoning_phase_start",
        assistantMessageId: "assistant-phase",
        responseId: "provider-response-phase",
        observedAt: T0 + 1_000,
        phaseStartedAt: T0 + 1_000,
      },
      1_000,
    ),
  );
  const row = projection.getSnapshot().rows.window.find((candidate) => candidate.kind === "reasoning");
  assert.equal(row?.kind === "reasoning" && row.assistantResponseId, "assistant-phase");
});

test("reasoning_phase_start 缺 assistantMessageId 时退回 provider responseId 兼容旧事件", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-ring-phase-2");
  startTurn(projection, 1, 0);
  projection.applyEvent(
    event(
      SessionEventType.ModelStreaming,
      {
        kind: "reasoning_phase_start",
        responseId: "provider-response-only",
        observedAt: T0 + 1_000,
        phaseStartedAt: T0 + 1_000,
      },
      1_000,
    ),
  );
  const row = projection.getSnapshot().rows.window.find((candidate) => candidate.kind === "reasoning");
  assert.equal(row?.kind === "reasoning" && row.assistantResponseId, "provider-response-only");
});
