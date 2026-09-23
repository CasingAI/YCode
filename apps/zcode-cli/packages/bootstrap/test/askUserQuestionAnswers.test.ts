import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type MessageWithParts, type SessionEvent } from "@zcode/contracts";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";

// AskUserQuestion 的答案只在 PermissionResolved.modifiedInput.answers 里出现。
// 工具行必须把改写后的入参当成唯一入参事实，否则用户填的答案在收起态显示成
// 「未提供回答」；tool part 也必须落同一份入参，否则 CLI 重启后冷恢复又丢答案。

const T0 = 1_700_000_000_000;

const QUESTIONS = [
  {
    question: "代理怎么配？",
    header: "Proxy",
    multiSelect: false,
    options: [{ value: "a", label: "A" }],
  },
];

const MODEL_INPUT = { questions: QUESTIONS };
const ANSWERED_INPUT = {
  questions: QUESTIONS,
  answers: { "代理怎么配？": "先讲远期的想法：走本机 7890 代理。" },
};

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
    sessionId: "sess-ask-user-question",
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

function applyAskUserQuestionScheduled(projection: ProductProjection): void {
  projection.applyEvent(
    makeEvent(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "call-1",
        assistantMessageId: "msg-1",
        toolName: "AskUserQuestion",
        input: MODEL_INPUT,
        schedule: { parallelGroups: [["call-1"]], executionOrder: ["call-1"] },
      },
      T0 + 1_000,
    ),
  );
}

function toolRows(projection: ProductProjection): ToolCallRow[] {
  return projection
    .getSnapshot()
    .rows.window.filter((row): row is ToolCallRow => row.kind === "toolCall");
}

test("权限改写后，工具行换成改写后的入参（答案可见），且 inputText 同步", () => {
  const projection = new ProductProjection("sess-ask-user-question", "epoch-1");
  startRunningTurn(projection);
  applyAskUserQuestionScheduled(projection);

  const before = toolRows(projection)[0];
  assert.deepEqual(before?.input, MODEL_INPUT);

  projection.applyEvent(
    makeEvent(
      SessionEventType.PermissionResolved,
      { requestId: "perm-1", toolCallId: "call-1", decision: "modify", modifiedInput: ANSWERED_INPUT },
      T0 + 2_000,
    ),
  );

  const row = toolRows(projection)[0];
  assert.equal(row?.status, "running");
  assert.deepEqual(row?.input, ANSWERED_INPUT);
  assert.equal(row?.inputText, JSON.stringify(ANSWERED_INPUT));
});

test("用户拒绝（deny）时行保持模型入参，不伪造答案", () => {
  const projection = new ProductProjection("sess-ask-user-question", "epoch-1");
  startRunningTurn(projection);
  applyAskUserQuestionScheduled(projection);

  projection.applyEvent(
    makeEvent(
      SessionEventType.PermissionResolved,
      { requestId: "perm-1", toolCallId: "call-1", decision: "deny" },
      T0 + 2_000,
    ),
  );

  const row = toolRows(projection)[0];
  assert.equal(row?.status, "cancelled");
  assert.deepEqual(row?.input, MODEL_INPUT);
});

test("提交答案后回合被取消：答案仍留在行上", () => {
  const projection = new ProductProjection("sess-ask-user-question", "epoch-1");
  startRunningTurn(projection);
  applyAskUserQuestionScheduled(projection);

  projection.applyEvent(
    makeEvent(
      SessionEventType.PermissionResolved,
      { requestId: "perm-1", toolCallId: "call-1", decision: "modify", modifiedInput: ANSWERED_INPUT },
      T0 + 2_000,
    ),
  );
  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnComplete,
      {
        response: "",
        tokenCount: 0,
        toolCallCount: 1,
        duration: 4_000,
        resultType: "cancelled",
      },
      T0 + 5_000,
    ),
  );

  const row = toolRows(projection)[0];
  assert.equal(row?.status, "cancelled");
  assert.deepEqual(row?.input, ANSWERED_INPUT);
});

test("冷恢复：part 里的有效入参合成 ToolCallScheduled，重放后与直播同一份答案", () => {
  const events = synthesizeEventsFromMessages([assistantMessageWithAnsweredToolPart()], {
    sessionId: "sess-ask-user-question",
    baseTimestampMs: T0,
  });
  const scheduled = events.find((event) => event.type === SessionEventType.ToolCallScheduled);
  assert.ok(scheduled, "冷恢复必须合成工具调度事件");
  assert.deepEqual((scheduled.payload as { input?: unknown }).input, ANSWERED_INPUT);

  const projection = new ProductProjection("sess-ask-user-question", "epoch-1");
  for (const event of events) {
    projection.applyEvent(event);
  }

  const row = toolRows(projection)[0];
  assert.deepEqual(row?.input, ANSWERED_INPUT);
  assert.equal(row?.toolName, "AskUserQuestion");
});

function assistantMessageWithAnsweredToolPart(): MessageWithParts {
  return {
    info: {
      id: "msg-1",
      sessionID: "sess-ask-user-question",
      role: "assistant",
      time: { created: T0 + 500 },
    },
    parts: [
      {
        id: "part-1",
        sessionID: "sess-ask-user-question",
        messageID: "msg-1",
        callID: "call-1",
        type: "tool",
        tool: "AskUserQuestion",
        state: {
          status: "completed",
          input: ANSWERED_INPUT,
          output: 'User has answered your questions: "代理怎么配？"="先讲远期的想法：走本机 7890 代理。"',
          title: "AskUserQuestion",
          metadata: {},
          time: { start: T0 + 1_000, end: T0 + 2_500 },
        },
      },
    ],
  } as unknown as MessageWithParts;
}
