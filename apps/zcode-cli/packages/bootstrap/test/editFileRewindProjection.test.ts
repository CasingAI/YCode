// 编辑点文件回滚粗判信号与 userInput 行 preview resolver 的回归测试
// （specs/message-history-edit.md 规则 23-24、40）。
//
// 规则 24：文件回滚范围是编辑点之后全部轮次，不是本行 turn 自己的 fileChanges。
// 规则 40（2026-10-06 修订）：粗判口径与 preview 的 getMessageIdsAfterRow 对齐——
// 目标行是所在轮第一条 realUser 行时自身轮 fileChanges 计入（编辑重发会丢弃
// 自身轮回复，其文件改动落在恢复范围内）；此前末轮恒判「无文件」误禁 rewind 按钮。
// 投影必须把上述总数聚合到 actions.editFileRewindFiles，
// UI 才不会用本轮 fileChanges 误判「无文件」而禁用 rewind 按钮。
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

test("editFileRewindFiles 聚合编辑点之后全部轮的 files 总数（首条 realUser 行计入自身轮，规则 40）", () => {
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
    rows.map((row) => row.actions?.editFileRewindFiles),
    [1 + 2 + 3, 2 + 3, 3],
    "粗判=编辑点之后全部消息口径（规则 40）：每行都是所在轮首条 realUser 行，自身轮 fileChanges 计入；此前末轮恒为 0 误禁 rewind 按钮",
  );
  assert.deepEqual(
    rows.map((row) => row.actions?.editTruncateTurns),
    [2, 1, 0],
    "截断轮数口径不受影响",
  );
  for (const row of projection.getSnapshot().rows.window) {
    const parsed = conversationRowSchema.safeParse(row);
    assert.ok(parsed.success, `携带 editFileRewindFiles 的行应通过协议校验（kind=${row.kind}）`);
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

test("插话（guide steer）行不是首条 realUser 行：自身轮保守不计，交 preview 把关（规则 40）", () => {
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
      ["question-1", 2],
      ["question-2", 0],
      // 插话行：轮级统计分不出它之前的改动，保守不计自身轮；后续轮（无）为 0。
      ["插话-补充要求", 0],
    ],
    "非首条 realUser 行不把插话前的文件改动算进粗判（宁缺勿假阳性），精确范围以 preview 为准",
  );
});
