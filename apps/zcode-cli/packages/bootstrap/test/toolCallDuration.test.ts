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

function scheduleTool(
  projection: ProductProjection,
  toolCallId: string,
  at: number,
  input: Record<string, unknown> = { command: "sleep 4" },
): void {
  projection.applyEvent(
    makeEvent(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId,
        toolName: "Bash",
        input,
        assistantMessageId: "msg-1",
      },
      at,
    ),
  );
}

function startBackgroundTask(
  projection: ProductProjection,
  toolCallId: string,
  taskId: string,
  at: number,
): void {
  projection.applyEvent(
    makeEvent(
      SessionEventType.BackgroundTaskStarted,
      { taskId, toolCallId, toolName: "Bash", taskKind: "bash", status: "running" },
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

// ── 后台移交：两种成因都不显示耗时（docs/specs/tool-call-duration.md「后台移交」）──
// BackgroundTaskStarted 早于 ToolCallResult 到达（实测早约 1ms），行在收口时就已带
// backgrounded，withToolCallTiming 据此不派生耗时。摘要行改显「后台」/「转后台」，
// 成因由入参里有无 run_in_background 区分（packages/ui/src/v4/toolCallBackgroundKind.ts）。

test("显式后台（入参带 run_in_background）：写 backgrounded/workId 且不写 durationMs", () => {
  const projection = new ProductProjection("sess-tool-duration", "epoch-1");
  startRunningTurn(projection);

  scheduleTool(projection, "call-1", T0 + 1_000, {
    command: "sleep 180",
    run_in_background: true,
  });
  startTool(projection, "call-1", T0 + 2_000);
  startBackgroundTask(projection, "call-1", "work-1", T0 + 2_500);
  finishTool(projection, "call-1", T0 + 3_000);

  const rows = toolRows(projection);
  assert.equal(rows[0]?.status, "success");
  assert.equal(rows[0]?.backgrounded, true);
  assert.equal(rows[0]?.workId, "work-1");
  // 1 秒只是 spawn 成本，不是这次执行的用时。
  assert.equal(rows[0]?.durationMs, undefined);
});

test("超时转后台（入参无 run_in_background）：同样只标 backgrounded、不写 durationMs", () => {
  const projection = new ProductProjection("sess-tool-duration", "epoch-1");
  startRunningTurn(projection);

  scheduleTool(projection, "call-1", T0 + 1_000, { command: "sleep 60", timeout: 20_000 });
  startTool(projection, "call-1", T0 + 2_000);
  // 跑满 20 秒 timeout 后运行时移交：62 秒是「跑了多久才被移交」，不是用时。
  startBackgroundTask(projection, "call-1", "work-1", T0 + 22_000);
  finishTool(projection, "call-1", T0 + 22_500);

  const rows = toolRows(projection);
  assert.equal(rows[0]?.backgrounded, true);
  assert.equal(rows[0]?.durationMs, undefined);
  // 成因要能从入参读出来，否则界面分不清该说「后台」还是「转后台」。
  assert.equal((rows[0]?.input as { run_in_background?: boolean }).run_in_background, undefined);
});

test("BackgroundTaskStarted 迟到时清掉已写的 durationMs，两条时序终态一致", () => {
  const projection = new ProductProjection("sess-tool-duration", "epoch-1");
  startRunningTurn(projection);

  scheduleTool(projection, "call-1", T0 + 1_000, { command: "sleep 60", timeout: 20_000 });
  startTool(projection, "call-1", T0 + 2_000);
  finishTool(projection, "call-1", T0 + 22_500);
  assert.equal(toolRows(projection)[0]?.durationMs, 20_500);

  startBackgroundTask(projection, "call-1", "work-1", T0 + 23_000);
  const rows = toolRows(projection);
  assert.equal(rows[0]?.backgrounded, true);
  assert.equal(rows[0]?.durationMs, undefined);
});

test("定位不到工具行的后台事件不产 delta，也不影响其它行", () => {
  const projection = new ProductProjection("sess-tool-duration", "epoch-1");
  startRunningTurn(projection);

  scheduleTool(projection, "call-1", T0 + 1_000);
  startTool(projection, "call-1", T0 + 2_000);
  finishTool(projection, "call-1", T0 + 6_000);
  startBackgroundTask(projection, "call-unknown", "work-9", T0 + 7_000);

  const rows = toolRows(projection);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.backgrounded, undefined);
  assert.equal(rows[0]?.durationMs, 4_000);
  // backgroundWorks 仍要维护：后台工作面板与取消入口靠它。
  assert.equal(projection.getSnapshot().backgroundWorks.length, 1);
});
