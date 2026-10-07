import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { conversationRowSchema, type UserInputRow } from "@zcode/shared/zcode-protocol-v4";
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

// 权限轴移除前的旧值（build/edit/auto）与未知值来自历史日志重放，值域过不了协议侧
// submissionModeSchema 校验。原样透传曾让整个 conversationRowsRangeV4 响应在 host 侧
// 校验失败，长会话向上翻页整页拉不动（P0，2026-09-28）——旧值映射不回三档，丢弃字段。
for (const legacyMode of ["build", "edit", "auto", "unknown-mode"]) {
  test(`旧权限轴值 ${legacyMode} 不透传进协议行`, () => {
    const projection = new ProductProjection(SESSION_ID, "epoch-1");

    projection.applyEvent(
      makeEvent(
        SessionEventType.TurnStarted,
        {
          turnNumber: 1,
          input: "hello",
          messageId: "msg-legacy",
          executionKind: "agent",
          intent: {
            sourceCommandId: "cmd-legacy",
            queueItemId: "q-legacy",
            clientId: "client-legacy",
            kind: "sendText",
            mode: legacyMode,
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
    assert.equal(rows[0]?.admissionMode, undefined, `admissionMode 不应透传 ${legacyMode}`);
    // 行字段必须整体过得了协议校验——守门前正是这里让整页 rowsRange 响应 FAIL。
    for (const row of projection.getSnapshot().rows.window) {
      const parsed = conversationRowSchema.safeParse(row);
      assert.ok(parsed.success, `行应通过协议校验（mode=${legacyMode}, kind=${row.kind}）`);
    }
  });
}

// commandKind（admission 命令身份）写入 userInput row：气泡 goal 芯片的唯一权威
// （docs/specs/goal-command-scope-and-decoration.md「回显边界」2026-10-07 权威化）。
// 事件 intent.kind 经 event-normalizer 归一化为 fact.intentKind；旧事件无 intent 时
// 归一化默认 sendText 不是凭空补值——legacy 导入行不可能是 goal 命令（goal 必经
// v4 admission 的 sendGoalCommand 命令），默认值即正确身份。
test("TurnStarted 把 commandKind 写进 userInput row（goal 与普通两条路径）", () => {
  const goal = new ProductProjection(SESSION_ID, "epoch-1");
  goal.applyEvent(
    makeEvent(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "/goal 修复登录",
        messageId: "msg-goal",
        executionKind: "agent",
        intent: {
          sourceCommandId: "cmd-goal",
          queueItemId: "q-goal",
          clientId: "client-goal",
          kind: "sendGoalCommand",
          admissionSeq: 0,
          admittedAt: T0,
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
        },
      },
      T0,
    ),
  );
  assert.equal(userInputRows(goal)[0]?.commandKind, "sendGoalCommand");

  const plain = new ProductProjection(SESSION_ID, "epoch-1");
  plain.applyEvent(
    makeEvent(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "你可以用 /goal 设目标",
        messageId: "msg-plain",
        executionKind: "agent",
        intent: {
          sourceCommandId: "cmd-plain",
          queueItemId: "q-plain",
          clientId: "client-plain",
          kind: "sendText",
          admissionSeq: 0,
          admittedAt: T0,
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
        },
      },
      T0,
    ),
  );
  // 普通 prompt 正文里的 /goal 字样不得让回显误画成命令芯片。
  assert.equal(userInputRows(plain)[0]?.commandKind, "sendText");
});

test("旧事件无 intent 时 commandKind 归一化为 sendText（legacy 导入不可能是 goal 命令）", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "hello", messageId: "msg-no-intent", executionKind: "agent" },
      T0,
    ),
  );
  assert.equal(userInputRows(projection)[0]?.commandKind, "sendText");
});
