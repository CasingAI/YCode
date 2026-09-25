import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionEventType,
  createSessionId,
  createToolCallId,
  createTraceId,
  type SessionEvent,
} from "@zcode/contracts";
import { createExploreSubagentPort } from "../src/subagent/runner.js";

// 子代理用量口径：成功路径由 child TurnResult 统计；失败/取消没有 TurnResult，
// 必须回读子会话已落库事件，否则终态前真实发生的工具与思考会被记成 0。

const T0 = 1_700_000_000_000;

function request() {
  return {
    sessionId: createSessionId(),
    parentToolCallId: createToolCallId(),
    agentType: "general-purpose",
    description: "usage test",
    prompt: "return the result",
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    trace: { traceId: createTraceId() },
  };
}

let seq = 0;
function childEvent(
  type: SessionEventType,
  payload: unknown,
  offsetMs: number,
  sessionId: string,
): SessionEvent {
  seq += 1;
  return {
    id: `child-event-${seq}`,
    sessionId,
    turnId: "child-turn-1",
    type,
    timestamp: new Date(T0 + offsetMs),
    traceId: "trace-child",
    sequenceNumber: seq,
    payload,
  } as unknown as SessionEvent;
}

/** child 事件流：2 次自身工具 + 一段 6 秒 reasoning + 一层嵌套子代理合计。 */
function childEvents(sessionId: string): SessionEvent[] {
  return [
    childEvent(
      SessionEventType.ModelStreaming,
      { kind: "reasoning_start", delta: "", done: false, assistantMessageId: "m1", partId: "p1" },
      1_000,
      sessionId,
    ),
    childEvent(
      SessionEventType.ModelStreaming,
      { kind: "reasoning_end", delta: "", done: false, partId: "p1" },
      7_000,
      sessionId,
    ),
    childEvent(
      SessionEventType.ToolCallResult,
      { toolCallId: "c1", result: { success: true, content: "ok" }, duration: 100 },
      8_000,
      sessionId,
    ),
    childEvent(
      SessionEventType.ToolCallResult,
      { toolCallId: "c2", result: { success: true, content: "ok" }, duration: 100 },
      9_000,
      sessionId,
    ),
    // grandchild 的合计。child 自己的 toolCallCount 只数到 grandchild 的 launcher，
    // grandchild 内部的调用必须靠这条 SubagentStopped 递归进来。
    childEvent(
      SessionEventType.SubagentStopped,
      {
        agentId: "grandchild",
        status: "completed",
        totalToolUseCount: 4,
        totalReasoningDurationMs: 3_000,
      },
      10_000,
      sessionId,
    ),
    childEvent(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 2, duration: 9_000, resultType: "success" },
      11_000,
      sessionId,
    ),
  ];
}

/** child 自身 2 次 + grandchild 4 次 = 6 次；reasoning 6s + grandchild 3s = 9s。 */
const EXPECTED_TOOL_CALL_COUNT = 6;
const EXPECTED_REASONING_MS = 9_000;

test("成功路径递归合并嵌套子代理的工具次数与思考耗时", async () => {
  const stopped: SessionEvent[] = [];
  let childSessionId: string | undefined;
  const port = createExploreSubagentPort({
    runExploreAgent: async (child) => {
      childSessionId = child.sessionId;
      return {
        response: "done",
        traceId: child.traceContext.traceId,
        events: childEvents(child.sessionId),
      };
    },
    emitParentEvent: async (event) => {
      stopped.push(event);
    },
  });

  const output = await port.run(request());

  assert.equal(output.status, "completed");
  assert.equal(output.totalToolUseCount, EXPECTED_TOOL_CALL_COUNT);
  assert.equal(output.totalReasoningDurationMs, EXPECTED_REASONING_MS);

  const event = stopped.find((item) => item.type === SessionEventType.SubagentStopped);
  const payload = event?.payload as Record<string, unknown> | undefined;
  assert.equal(payload?.totalToolUseCount, EXPECTED_TOOL_CALL_COUNT);
  assert.equal(payload?.totalReasoningDurationMs, EXPECTED_REASONING_MS);
  assert.equal(payload?.childSessionId, childSessionId);
});

test("失败路径回读子会话事件，终态前发生的用量不丢", async () => {
  const events: SessionEvent[] = [];
  const port = createExploreSubagentPort({
    runExploreAgent: async () => {
      throw new Error("child runtime crashed");
    },
    emitParentEvent: async (event) => {
      events.push(event);
    },
    readChildSessionEvents: async (childSessionId) => childEvents(childSessionId),
  });

  const output = await port.run(request());

  assert.equal(output.status, "failed");
  assert.equal(output.totalToolUseCount, EXPECTED_TOOL_CALL_COUNT);
  assert.equal(output.totalReasoningDurationMs, EXPECTED_REASONING_MS);

  const event = events.find((item) => item.type === SessionEventType.SubagentStopped);
  const payload = event?.payload as Record<string, unknown> | undefined;
  assert.equal(payload?.totalToolUseCount, EXPECTED_TOOL_CALL_COUNT);
  assert.equal(payload?.totalReasoningDurationMs, EXPECTED_REASONING_MS);
});

test("取消路径同样回读用量，状态行不会因中断而归零", async () => {
  const controller = new AbortController();
  const events: SessionEvent[] = [];
  const port = createExploreSubagentPort({
    runExploreAgent: async () => {
      controller.abort(new Error("parent turn cancelled"));
      await new Promise((resolve) => setTimeout(resolve, 1));
      throw new Error("aborted");
    },
    emitParentEvent: async (event) => {
      events.push(event);
    },
    readChildSessionEvents: async (childSessionId) => childEvents(childSessionId),
  });

  const output = await port.run(request(), { signal: controller.signal });

  assert.equal(output.status, "cancelled");
  assert.equal(output.totalToolUseCount, EXPECTED_TOOL_CALL_COUNT);
  assert.equal(output.totalReasoningDurationMs, EXPECTED_REASONING_MS);
});

test("回读失败时终态与事件都不带用量字段，不落盘伪造的 0", async () => {
  const events: SessionEvent[] = [];
  const port = createExploreSubagentPort({
    runExploreAgent: async () => {
      throw new Error("child runtime crashed");
    },
    emitParentEvent: async (event) => {
      events.push(event);
    },
    readChildSessionEvents: async () => {
      throw new Error("event store unavailable");
    },
  });

  const output = await port.run(request());

  assert.equal(output.status, "failed");
  // 缺席 = 未知。写成 0 会被冷恢复当成真实统计，直播与重启后数字就会不一致。
  assert.equal(output.totalToolUseCount, undefined);
  assert.equal(output.totalReasoningDurationMs, undefined);
  assert.equal("totalToolUseCount" in output, false);

  const event = events.find((item) => item.type === SessionEventType.SubagentStopped);
  const payload = event?.payload as Record<string, unknown> | undefined;
  assert.equal(payload?.totalToolUseCount, undefined);
  assert.equal(payload?.totalReasoningDurationMs, undefined);
});

test("没有接 readChildSessionEvents 的旧注入实现行为不变：终态不带用量", async () => {
  const events: SessionEvent[] = [];
  const port = createExploreSubagentPort({
    runExploreAgent: async () => {
      throw new Error("child runtime crashed");
    },
    emitParentEvent: async (event) => {
      events.push(event);
    },
  });

  const output = await port.run(request());

  assert.equal(output.status, "failed");
  assert.equal(output.totalToolUseCount, undefined);
  const event = events.find((item) => item.type === SessionEventType.SubagentStopped);
  const payload = event?.payload as Record<string, unknown> | undefined;
  assert.equal(payload?.totalToolUseCount, undefined);
});
