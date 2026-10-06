// 引导内联行（guide steer）编辑重发后 live 裁剪范围的回归测试
// （specs/message-history-edit.md 规则 41）。
//
// 规则 41（2026-10-06，真机 bug 修复）：guide steer 行由 onTurnSteerDrained 内联进
// 原任务 product turn（仅 queue 交付才切段）。runtime rewind 锚点是引导消息本身，
// keptMessageIDs 保留同轮前缀；live 投影 onRewindTriggered 的 row.removed 起点若
// 回溯到所属轮 turnHeader，会把同轮前序行（原始任务消息气泡）从时间线误删——
// 表现为「编辑引导消息后前面那条消息不见了」，刷新后才复活。
import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  conversationRowSchema,
  type TurnHeaderRow,
  type UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

const T0 = 1_700_000_000_000;
const SESSION_ID = "sess-edit-guide-steer-rewind";

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
    traceId: "trace-edit-guide-steer-rewind",
    sequenceNumber: seq,
    payload,
  } as unknown as SessionEvent;
}

function startUserTurn(projection: ProductProjection): void {
  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "question-1",
        messageId: "msg-1",
        executionKind: "agent",
        intent: {
          sourceCommandId: "cmd-1",
          queueItemId: "q-1",
          clientId: "client-1",
          kind: "sendText",
          mode: "readonly",
          modelSelection: { providerId: "glm", modelId: "glm-4.6" },
          admissionSeq: 1,
          admittedAt: T0 + 1,
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
        },
      },
      T0 + 1,
      "turn-1",
    ),
  );
}

function assistantReply(
  projection: ProductProjection,
  assistantMessageId: string,
  timestampMs: number,
): void {
  projection.applyEvent(
    makeEvent(
      SessionEventType.ModelStreaming,
      {
        kind: "text_start",
        delta: `answer-${assistantMessageId}`,
        assistantMessageId,
        partId: `part-${assistantMessageId}`,
      },
      timestampMs,
      "turn-1",
    ),
  );
}

function steerDrained(
  projection: ProductProjection,
  delivery: "guide" | "queue",
  timestampMs: number,
): void {
  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnSteerDrained,
      {
        targetTurnId: "turn-1",
        pendingInputIds: ["pending-1"],
        drainedInputs: [
          {
            pendingInputId: "pending-1",
            messageId: "msg-steer-1",
            text: "1",
            delivery,
          },
        ],
      },
      timestampMs,
      "turn-1",
    ),
  );
}

function rewindTriggered(projection: ProductProjection, timestampMs: number): void {
  projection.applyEvent(
    makeEvent(
      SessionEventType.RewindTriggered,
      {
        rewindId: "rewind-1",
        scope: "conversation",
        strategy: "active_chain",
        targetMessageId: "msg-steer-1",
        branchCutAfterMessageId: "asst-msg-steer-1",
        branchGeneration: 1,
      },
      timestampMs,
      "turn-1",
    ),
  );
}

function steerRowOf(projection: ProductProjection): UserInputRow {
  const row = projection
    .getSnapshot()
    .rows.window.find(
      (candidate): candidate is UserInputRow =>
        candidate.kind === "userInput" && candidate.entityId === "msg-steer-1",
    );
  assert.ok(row, "fixture 应产生引导 steer 的 userInput 行");
  return row;
}

function turnHeaderRows(projection: ProductProjection): TurnHeaderRow[] {
  return projection
    .getSnapshot()
    .rows.window.filter((row): row is TurnHeaderRow => row.kind === "turnHeader");
}

test("编辑引导内联行：从引导行自身起裁剪，同轮前序 user 气泡与 turnHeader 保留（规则 41）", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  startUserTurn(projection);
  assistantReply(projection, "asst-msg-1", T0 + 1.5);
  steerDrained(projection, "guide", T0 + 2);
  assistantReply(projection, "asst-msg-steer-1", T0 + 2.5);

  const steerRow = steerRowOf(projection);
  assert.equal(steerRow.guided, true, "fixture：guide 交付行必须带 guided 标记");
  assert.ok(steerRow.rowId > 0);

  rewindTriggered(projection, T0 + 3);

  const window = projection.getSnapshot().rows.window;
  const originalUserRow = window.find(
    (row): row is UserInputRow => row.kind === "userInput" && row.text === "question-1",
  );
  assert.ok(originalUserRow, "同轮前序的原始任务消息气泡必须保留（真机丢失的正是它）");
  assert.ok(originalUserRow.rowId < steerRow.rowId);
  const headers = turnHeaderRows(projection);
  assert.equal(headers.length, 1, "原轮 turnHeader 保留（轮的前半段仍在 active branch）");
  assert.ok(
    window.every((row) => row.rowId < steerRow.rowId),
    "引导行及其后的所有行从时间线移除",
  );
  for (const row of window) {
    const parsed = conversationRowSchema.safeParse(row);
    assert.ok(parsed.success, `裁剪后剩余行应通过协议校验（kind=${row.kind}）`);
  }
  assert.equal(
    projection.resolveEditTargetByEntityId("msg-steer-1"),
    null,
    "被剪除引导行的 edit target 必须随裁剪清理，entityId 直查不再放行",
  );
});

test("编辑 queue 交付的插话行：维持从切段后新轮 turnHeader 起裁剪的既有语义", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  startUserTurn(projection);
  assistantReply(projection, "asst-msg-1", T0 + 1.5);
  steerDrained(projection, "queue", T0 + 2);
  assistantReply(projection, "asst-msg-steer-1", T0 + 2.5);

  // queue 交付已切段：steer 行之前的行属于原轮，steer 行起属于新轮。
  const steerRow = steerRowOf(projection);
  assert.notEqual(steerRow.guided, true);
  const originalUserRowBefore = projection
    .getSnapshot()
    .rows.window.find((row): row is UserInputRow => row.kind === "userInput");
  assert.ok(originalUserRowBefore && originalUserRowBefore.rowId < steerRow.rowId);

  rewindTriggered(projection, T0 + 3);

  const window = projection.getSnapshot().rows.window;
  assert.ok(
    window.some(
      (row): row is UserInputRow => row.kind === "userInput" && row.text === "question-1",
    ),
    "原轮 user 气泡保留",
  );
  assert.equal(
    turnHeaderRows(projection).length,
    1,
    "切段后的新轮 turnHeader 随裁剪移除，仅剩原轮 turnHeader",
  );
  assert.ok(window.every((row) => row.rowId < steerRow.rowId));
});
