import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type MessageWithParts, type SessionEvent } from "@zcode/contracts";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";

const T0 = 1_700_000_000_000;
const SESSION_ID = "sess-task-output-display";
const TITLE = "运行全仓 TypeScript 类型检查";

let sequence = 0;
function makeEvent(type: SessionEventType, payload: unknown, offsetMs: number): SessionEvent {
  sequence += 1;
  return {
    id: `event-${sequence}`,
    sessionId: SESSION_ID,
    turnId: "turn-1",
    type,
    timestamp: new Date(T0 + offsetMs),
    traceId: "trace-task-output-display",
    sequenceNumber: sequence,
    payload,
  } as unknown as SessionEvent;
}

function startTaskOutputTurn(projection: ProductProjection): void {
  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "等待任务输出", executionKind: "agent" },
      0,
    ),
  );
  projection.applyEvent(
    makeEvent(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "call-task-output",
        assistantMessageId: "assistant-1",
        toolName: "TaskOutput",
        input: { task_id: "exec-task-output" },
        schedule: { parallelGroups: [["call-task-output"]], executionOrder: ["call-task-output"] },
      },
      1_000,
    ),
  );
}

function taskOutputRows(projection: ProductProjection): ToolCallRow[] {
  return projection
    .getSnapshot()
    .rows.window.filter((row): row is ToolCallRow => row.kind === "toolCall");
}

test("TaskOutput display title 通过实时工具结果投影到工具行", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-live");
  startTaskOutputTurn(projection);

  projection.applyEvent(
    makeEvent(
      SessionEventType.ToolCallResult,
      {
        toolCallId: "call-task-output",
        duration: 10,
        result: {
          success: true,
          content: "done",
          display: {
            kind: "task_output",
            retrievalStatus: "success",
            title: TITLE,
            taskStatus: "completed",
            output: "done",
          },
        },
      },
      2_000,
    ),
  );

  assert.equal(taskOutputRows(projection)[0]?.output?.display?.title, TITLE);
});

test("TaskOutput display title 从持久化 tool part metadata 冷恢复", () => {
  const message = {
    info: {
      id: "assistant-1",
      sessionID: SESSION_ID,
      role: "assistant",
      time: { created: T0 + 500 },
    },
    parts: [
      {
        id: "part-task-output",
        sessionID: SESSION_ID,
        messageID: "assistant-1",
        callID: "call-task-output",
        type: "tool",
        tool: "TaskOutput",
        state: {
          status: "completed",
          input: { task_id: "exec-task-output" },
          output: "done",
          title: "TaskOutput",
          metadata: {
            schemaVersion: 1,
            display: {
              kind: "task_output",
              retrievalStatus: "success",
              title: TITLE,
              taskStatus: "completed",
              output: "done",
            },
          },
          time: { start: T0 + 1_000, end: T0 + 2_000 },
        },
      },
    ],
  } as unknown as MessageWithParts;

  const events = synthesizeEventsFromMessages([message], {
    sessionId: SESSION_ID,
    baseTimestampMs: T0,
  });
  const projection = new ProductProjection(SESSION_ID, "epoch-cold");
  for (const event of events) projection.applyEvent(event);

  assert.equal(taskOutputRows(projection)[0]?.output?.display?.title, TITLE);
});
