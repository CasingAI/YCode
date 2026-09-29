import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

// 工具行耗时：必须由「ToolCallStarted 事件时间」与「终态事件时间」派生，
// 且口径是纯执行时间——startedAt 只在真正开始执行时写，审批等待期间没有它，
// 因此审批耗时天然被排除在外。旧实现只写 endedAt 不写 durationMs，界面无数字可显示。
// 详见 docs/specs/tool-call-duration.md。

const T0 = 1_700_000_000_000;

let seq = 0;
function makeEvent(
  type: SessionEventType,
  payload: unknown,
  timestampMs: number,
): SessionEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    sessionId: "sess-tool-duration",
    turnId: "turn-1",
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

function scheduleTool(projection: ProductProjection, toolCallId: string, at: number): void {
  projection.applyEvent(
    makeEvent(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId,
        toolName: "Bash",
        input: { command: "sleep 4" },
        assistantMessageId: "msg-1",
      },
      at,
    ),
  );
}

function startTool(projection: ProductProjection, toolCallId: string, at: number): void {
  projection.applyEvent(
    makeEvent(SessionEventType.ToolCallStarted, { toolCallId, toolName: "Bash" }, at),
  );
}

function finishTool(projection: ProductProjection, toolCallId: string, at: number): void {
  projection.applyEvent(
    makeEvent(
      SessionEventType.ToolCallResult,
      { toolCallId, result: { success: true, content: "done" } },
      at,
    ),
  );
}

function toolRows(projection: ProductProjection): ToolCallRow[] {
  return projection
    .getSnapshot()
    .rows.window.filter((row): row is ToolCallRow => row.kind === "toolCall");
}

test("成功终态写入 durationMs = endedAt - startedAt", () => {
  const projection = new ProductProjection("sess-tool-duration", "epoch-1");
  startRunningTurn(projection);

  scheduleTool(projection, "call-1", T0 + 1_000);
  startTool(projection, "call-1", T0 + 2_000);
  finishTool(projection, "call-1", T0 + 6_000);

  const rows = toolRows(projection);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "success");
  assert.equal(rows[0]?.startedAt, T0 + 2_000);
  assert.equal(rows[0]?.endedAt, T0 + 6_000);
  assert.equal(rows[0]?.durationMs, 4_000);
});

test("审批等待不计入耗时：startedAt 在批准之后才写", () => {
  const projection = new ProductProjection("sess-tool-duration", "epoch-1");
  startRunningTurn(projection);

  // T0+1s 排程后长时间停在审批，直到 T0+30s 才真正启动。
  scheduleTool(projection, "call-1", T0 + 1_000);
  startTool(projection, "call-1", T0 + 30_000);
  finishTool(projection, "call-1", T0 + 34_000);

  const rows = toolRows(projection);
  // 29 秒的审批等待被排除，只算真正执行的 4 秒。
  assert.equal(rows[0]?.durationMs, 4_000);
});

test("从未执行的行（被拒绝）不写 durationMs，界面据此不显示耗时", () => {
  const projection = new ProductProjection("sess-tool-duration", "epoch-1");
  startRunningTurn(projection);

  scheduleTool(projection, "call-1", T0 + 1_000);
  projection.applyEvent(
    makeEvent(
      SessionEventType.ToolCallResult,
      {
        toolCallId: "call-1",
        result: {
          success: false,
          content: "",
          error: { type: "permission_denied", message: "user denied" },
          permissionDenial: { decision: "deny", reason: "user denied", source: "permission" },
        },
      },
      T0 + 3_000,
    ),
  );

  const rows = toolRows(projection);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "cancelled");
  assert.equal(rows[0]?.startedAt, undefined);
  assert.equal(rows[0]?.durationMs, undefined);
});

test("工具失败同样写入 durationMs", () => {
  const projection = new ProductProjection("sess-tool-duration", "epoch-1");
  startRunningTurn(projection);

  scheduleTool(projection, "call-1", T0 + 1_000);
  startTool(projection, "call-1", T0 + 2_000);
  projection.applyEvent(
    makeEvent(
      SessionEventType.ToolCallError,
      { toolCallId: "call-1", error: { type: "fault", message: "boom" } },
      T0 + 5_000,
    ),
  );

  const rows = toolRows(projection);
  assert.equal(rows[0]?.status, "error");
  assert.equal(rows[0]?.durationMs, 3_000);
});

test("回合收口强制结束运行中的工具行时也补上 durationMs", () => {
  const projection = new ProductProjection("sess-tool-duration", "epoch-1");
  startRunningTurn(projection);

  scheduleTool(projection, "call-1", T0 + 1_000);
  startTool(projection, "call-1", T0 + 2_000);
  // 没有 ToolCallResult 直接 TurnComplete：closeOpenToolRows 收口运行态行。
  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 1, duration: 8_000, resultType: "success" },
      T0 + 10_000,
    ),
  );

  const rows = toolRows(projection);
  assert.equal(rows[0]?.durationMs, 8_000);
});

test("亚秒命令也写入真实 durationMs（显示层再向上取整为 1 秒）", () => {
  const projection = new ProductProjection("sess-tool-duration", "epoch-1");
  startRunningTurn(projection);

  scheduleTool(projection, "call-1", T0 + 1_000);
  startTool(projection, "call-1", T0 + 2_000);
  finishTool(projection, "call-1", T0 + 2_300);

  const rows = toolRows(projection);
  assert.equal(rows[0]?.durationMs, 300);
});
