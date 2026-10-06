import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  commandPayloadSchemas,
  conversationRowSchema,
  type UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

// 放开中间轮编辑（specs/message-history-edit.md）：可编辑权威从「末轮单值」变为
// 「全部有 canonical editTarget 的 realUser 行」集合。actions 与 resolver 必须在同一
// 次 materialization 中同源：多轮行都带 canEdit + editTruncateTurns，resolver 对
// 中间轮 entityId 也放行，未知实体仍拒绝。

const T0 = 1_700_000_000_000;
const SESSION_ID = "sess-edit-any-turn";

let seq = 0;
function makeEvent(
  type: SessionEventType,
  payload: unknown,
  timestampMs: number,
  turnId: string,
): SessionEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    sessionId: SESSION_ID,
    turnId,
    type,
    timestamp: new Date(timestampMs),
    traceId: "trace-edit-any-turn",
    sequenceNumber: seq,
    payload,
  } as unknown as SessionEvent;
}

function startUserTurn(projection: ProductProjection, index: number): void {
  const turnId = `turn-${index}`;
  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnStarted,
      {
        turnNumber: index,
        input: `question-${index}`,
        messageId: `msg-${index}`,
        executionKind: "agent",
        intent: {
          sourceCommandId: `cmd-${index}`,
          queueItemId: `q-${index}`,
          clientId: "client-1",
          kind: "sendText",
          mode: "readonly",
          modelSelection: { providerId: "glm", modelId: "glm-4.6" },
          admissionSeq: index,
          admittedAt: T0 + index,
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
        },
      },
      T0 + index,
      turnId,
    ),
  );
}

// 真机会话每轮 user 消息后都有回复行。倒序去重计数时同 turn 的后继行会把行自身
// turn 先计入 distinctTurns，只造 TurnStarted 的测试掩盖了该 off-by-one（真机上
// 末轮 editTruncateTurns 显示 1）。回复行是复现条件，必须与真实轮结构一致。
function assistantReply(projection: ProductProjection, index: number): void {
  projection.applyEvent(
    makeEvent(
      SessionEventType.ModelStreaming,
      {
        kind: "text_start",
        delta: `answer-${index}`,
        assistantMessageId: `asst-msg-${index}`,
        partId: `part-${index}`,
      },
      T0 + index + 0.5,
      `turn-${index}`,
    ),
  );
}

function userInputRows(projection: ProductProjection): UserInputRow[] {
  return projection
    .getSnapshot()
    .rows.window.filter((row): row is UserInputRow => row.kind === "userInput");
}

test("多轮 realUser 行都可编辑，editTruncateTurns 随轮递减", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  for (let index = 1; index <= 3; index += 1) {
    startUserTurn(projection, index);
    assistantReply(projection, index);
  }

  const rows = userInputRows(projection);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.actions?.editTruncateTurns),
    [2, 1, 0],
    "中间轮编辑放开后每行都携带截断轮数：目标行之后还有几轮，末轮为 0",
  );
  for (const row of rows) {
    assert.equal(row.actions?.canEdit, true);
    assert.equal(row.actions?.editDisposition, "rewind");
  }
});

test("resolver 对中间轮 entityId 放行并返回当年 intent，未知实体拒绝", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  for (let index = 1; index <= 2; index += 1) {
    startUserTurn(projection, index);
  }

  const firstTurnTarget = projection.resolveEditTargetByEntityId("msg-1");
  assert.ok(firstTurnTarget, "中间轮 entityId 必须可解析（放开 latest-only 的核心断言）");
  assert.equal(firstTurnTarget?.intent.text, "question-1");
  assert.equal(firstTurnTarget?.transcriptMessageId, "msg-1");

  const latestTarget = projection.resolveEditTargetByEntityId("msg-2");
  assert.ok(latestTarget);
  assert.equal(latestTarget?.intent.text, "question-2");

  assert.equal(projection.resolveEditTargetByEntityId("msg-unknown"), null);
});

test("携带 editTruncateTurns 的行整体通过协议校验", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  for (let index = 1; index <= 2; index += 1) {
    startUserTurn(projection, index);
  }

  for (const row of projection.getSnapshot().rows.window) {
    const parsed = conversationRowSchema.safeParse(row);
    assert.ok(parsed.success, `行应通过协议校验（kind=${row.kind}）`);
  }
});

test("editUserQuery payload 新参数覆盖字段可选且旧形状兼容", () => {
  const legacy = commandPayloadSchemas.editUserQuery.safeParse({
    target: { rowId: 1, entityId: "msg-1" },
    newText: "hello",
  });
  assert.ok(legacy.success, "旧客户端 payload（无覆盖字段）必须保持兼容");

  const full = commandPayloadSchemas.editUserQuery.safeParse({
    target: { rowId: 1, entityId: "msg-1" },
    newText: "hello",
    workspaceMode: "rewind",
    mode: "plan",
    modelSelection: { providerId: "glm", modelId: "glm-4.6" },
    planEnabled: true,
    readOnlyEnabled: false,
  });
  assert.ok(full.success, "新覆盖字段应通过校验");
  assert.equal(full.data?.mode, "plan");
  assert.equal(full.data?.planEnabled, true);
});
