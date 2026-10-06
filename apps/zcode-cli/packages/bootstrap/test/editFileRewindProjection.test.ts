// 编辑点文件回滚 preview resolver 回归测试（specs/message-history-edit.md 规则 23-24、40）。
//
// 规则 40（2026-10-06 交互收口）：编辑卡不再有「与文件一起重置」按钮，↑ 是唯一
// 提交入口、所有编辑提交先弹确认窗，弹窗文件清单以提交前 fileRewindPreview 为准。
// 曾随 actions 下发的 editFileRewindFiles 粗判只服务该按钮的可用性，随按钮一并
// 移除；本文件保留 resolver（preview 目标解析）与 editTruncateTurns 口径的回归。
// 规则 23：fileRewindPreview/applyFileRewind 必须接受 userInput 行目标
// （编辑卡提交前 preview），范围 = 编辑点之后的全部 messageId。
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
const SESSION_ID = "sess-edit-file-rewind";

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
    traceId: "trace-edit-file-rewind",
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

// 回复行让每轮结构与真机一致（同 turn 后继行在倒序遍历先于 userInput 出现）。
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

// ModelComplete 携带本轮文件摘要 → turnHeader.fileChanges（files 为计数）。
function modelCompleteWithFiles(projection: ProductProjection, index: number, files: number): void {
  projection.applyEvent(
    makeEvent(
      SessionEventType.ModelComplete,
      {
        stopReason: "end_turn",
        toolCallCount: 1,
        usage: { outputTokens: 1 },
        fileChanges: { additions: files, deletions: 0, files },
      },
      T0 + index + 0.9,
      `turn-${index}`,
    ),
  );
}

function userInputRows(projection: ProductProjection): UserInputRow[] {
  return projection
    .getSnapshot()
    .rows.window.filter((row): row is UserInputRow => row.kind === "userInput");
}

test("editTruncateTurns 聚合编辑点之后轮数；editFileRewindFiles 粗判不再下发（规则 40）", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  const filesByTurn = new Map([
    [1, 1],
    [2, 2],
    [3, 3],
  ]);
  for (let index = 1; index <= 3; index += 1) {
    startUserTurn(projection, index);
    assistantReply(projection, index);
    modelCompleteWithFiles(projection, index, filesByTurn.get(index) ?? 0);
  }

  const rows = userInputRows(projection);
  assert.deepEqual(
    rows.map((row) => row.actions?.editTruncateTurns),
    [2, 1, 0],
    "截断轮数口径不受影响",
  );
  assert.deepEqual(
    rows.map((row) => row.actions?.editFileRewindFiles),
    [undefined, undefined, undefined],
    "粗判信号随 rewind 按钮一并下线（规则 40），弹窗文件清单以提交前 preview 为准",
  );
  for (const row of projection.getSnapshot().rows.window) {
    const parsed = conversationRowSchema.safeParse(row);
    assert.ok(parsed.success, `actions 行应通过协议校验（kind=${row.kind}）`);
  }
  const header = projection
    .getSnapshot()
    .rows.window.find((row): row is TurnHeaderRow => row.kind === "turnHeader" && row.rowId > 0);
  assert.ok(header, "fixture 应产生 turnHeader 行");
});

test("resolver 接受 userInput 行的 fileRewindPreview 目标并返回编辑点后的 messageIds", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  for (let index = 1; index <= 3; index += 1) {
    startUserTurn(projection, index);
    assistantReply(projection, index);
  }

  const rows = userInputRows(projection);
  const first = rows[0]!;
  const resolution = projection.resolveRowActionTarget(
    { rowId: first.rowId, entityId: first.entityId! },
    "fileRewindPreview",
  );
  assert.ok(resolution.ok, "编辑行的 preview 目标必须可解析（编辑卡提交前弹窗数据源）");
  assert.ok(resolution.ok && Array.isArray(resolution.messageIds));
  const messageIds = resolution.ok ? resolution.messageIds : [];
  assert.ok(messageIds.includes("msg-2"), "编辑点之后的轮必须包含在恢复范围");
  assert.ok(messageIds.includes("msg-3"));
  assert.ok(messageIds.includes("msg-1"), "口径=目标行及其后全部行（目标 user msg 本身无 checkpoint，无副作用）");
});

test("resolver 拒绝非编辑行的 preview 目标（stale entityId）", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  startUserTurn(projection, 1);

  const rows = userInputRows(projection);
  const resolution = projection.resolveRowActionTarget(
    { rowId: rows[0]!.rowId, entityId: "msg-unknown" },
    "fileRewindPreview",
  );
  assert.equal(resolution.ok, false);
  assert.ok(!resolution.ok && resolution.status === "stale");
});

test("插话（guide steer）行同样获得 edit target；粗判下线后不区分首条 realUser 行（规则 40）", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  // turn-1：2 个文件；turn-2：无文件。
  startUserTurn(projection, 1);
  assistantReply(projection, 1);
  modelCompleteWithFiles(projection, 1, 2);
  startUserTurn(projection, 2);
  assistantReply(projection, 2);
  modelCompleteWithFiles(projection, 2, 0);
  // turn-2 内插话一条 guide steer：同一 product turn 的第二条 realUser 行。
  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnSteerDrained,
      {
        targetTurnId: "turn-2",
        pendingInputIds: ["pending-1"],
        drainedInputs: [
          {
            pendingInputId: "pending-1",
            messageId: "msg-steer-1",
            text: "插话-补充要求",
            delivery: "guide",
          },
        ],
      },
      T0 + 2 + 0.7,
      "turn-2",
    ),
  );

  const rows = userInputRows(projection);
  assert.deepEqual(
    rows.map((row) => [row.text, row.actions?.editFileRewindFiles]),
    [
      ["question-1", undefined],
      ["question-2", undefined],
      // 插话行：粗判已下线，所有人都是 undefined；文件后果统一由提交前 preview 呈现。
      ["插话-补充要求", undefined],
    ],
    "editFileRewindFiles 不再随 actions 下发（规则 40）",
  );
});
