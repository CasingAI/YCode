import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

// editUserQuery 重发沿用该轮冻结的 mode/modelSelection。行内编辑框只读展示它们，
// 数据由投影下发到 userInput row：普通 TurnStarted 与 queue 消费两条路径都要写。

const T0 = 1_700_000_000_000;
const SESSION_ID = "sess-admission-frozen";

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
    sessionId: SESSION_ID,
    turnId,
    type,
    timestamp: new Date(timestampMs),
    traceId: "trace-1",
    sequenceNumber: seq,
    payload,
  } as unknown as SessionEvent;
}

function userInputRows(projection: ProductProjection): UserInputRow[] {
  return projection
    .getSnapshot()
    .rows.window.filter((row): row is UserInputRow => row.kind === "userInput");
}

test("TurnStarted 把冻结的 mode/modelSelection 写进 userInput row", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");

  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "hello",
        messageId: "msg-1",
        executionKind: "agent",
        intent: {
          sourceCommandId: "cmd-1",
          queueItemId: "q-1",
          clientId: "client-1",
          kind: "sendText",
          modelSelection: { providerId: "glm", modelId: "glm-4.6" },
          mode: "readonly",
          admissionSeq: 0,
          admittedAt: T0,
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
        },
      },
      T0,
    ),
  );

  const rows = userInputRows(projection);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.admissionMode, "readonly");
  assert.deepEqual(rows[0]?.admissionModelSelection, {
    providerId: "glm",
    modelId: "glm-4.6",
  });
});

test("旧事件无 intent 时冻结字段缺席，不凭空补值", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");

  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "hello", messageId: "msg-2", executionKind: "agent" },
      T0,
    ),
  );

  const rows = userInputRows(projection);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.admissionMode, undefined);
  assert.equal(rows[0]?.admissionModelSelection, undefined);
});
