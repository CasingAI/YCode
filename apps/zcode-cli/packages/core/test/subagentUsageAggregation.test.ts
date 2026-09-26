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

// SubagentProgress：子代理运行期间父状态行必须跟着动。
// runner 用终态同一对解析函数取数，所以直播数字是终态数字的单调前缀。

/** 与 runner 的 SUBAGENT_PROGRESS_INTERVAL_MS 对齐；测试里只用于跨过节流窗口。 */
const SUBAGENT_PROGRESS_INTERVAL_MS_TEST = 1_600;

/** 让出事件循环，让 reportActivity 触发的 flush 有机会跑完。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

function progressEvents(events: SessionEvent[]): SessionEvent[] {
  return events.filter((item) => item.type === SessionEventType.SubagentProgress);
}

test("子代理运行中回传累计用量，父侧不必等到终态", async () => {
  const events: SessionEvent[] = [];
  const port = createExploreSubagentPort({
    runExploreAgent: async (child) => {
      // 模拟子代理跑了一段时间：期间调若干次 reportActivity 驱动上报。
      for (let i = 0; i < 3; i += 1) {
        child.reportActivity?.();
        await settle();
      }
      return {
        response: "done",
        traceId: child.traceContext.traceId,
        events: childEvents(child.sessionId),
      };
    },
    emitParentEvent: async (event) => {
      events.push(event);
    },
    readChildSessionEvents: async (childSessionId) => childEvents(childSessionId),
  });

  const output = await port.run(request());

  const progress = progressEvents(events);
  assert.ok(progress.length > 0, "子代理运行期间至少应回传一次进度");
  const payload = progress.at(-1)?.payload as Record<string, unknown> | undefined;
  assert.equal(payload?.totalToolUseCount, EXPECTED_TOOL_CALL_COUNT);
  assert.equal(payload?.totalReasoningDurationMs, EXPECTED_REASONING_MS);
  // 进度用的是与终态相同的解析函数，两处数字必须一致。
  assert.equal(payload?.totalToolUseCount, output.totalToolUseCount);
  assert.equal(payload?.totalReasoningDurationMs, output.totalReasoningDurationMs);
  // 进度事件先于终态到达。
  assert.ok(
    events.indexOf(progress.at(-1)!) <
      events.findIndex((item) => item.type === SessionEventType.SubagentStopped),
  );
});

test("节流窗口内的重复活动不产生进度事件", async () => {
  const events: SessionEvent[] = [];
  const port = createExploreSubagentPort({
    runExploreAgent: async (child) => {
      // 连续 5 次活动全落在 1500ms 节流窗口内。
      for (let i = 0; i < 5; i += 1) {
        child.reportActivity?.();
        await settle();
      }
      return {
        response: "done",
        traceId: child.traceContext.traceId,
        events: childEvents(child.sessionId),
      };
    },
    emitParentEvent: async (event) => {
      events.push(event);
    },
    readChildSessionEvents: async (childSessionId) => childEvents(childSessionId),
  });

  await port.run(request());

  // 首拍发一次，之后节流窗口内不再发；子代理已结束不会补发。
  assert.equal(progressEvents(events).length, 1);
});

test("空闲子代理没有活动信号时不产生任何进度事件", async () => {
  const events: SessionEvent[] = [];
  const port = createExploreSubagentPort({
    runExploreAgent: async (child) => {
      // 全程不调 reportActivity：子代理只是挂着等，没有任何事件流。
      await settle();
      return {
        response: "done",
        traceId: child.traceContext.traceId,
        events: childEvents(child.sessionId),
      };
    },
    emitParentEvent: async (event) => {
      events.push(event);
    },
    readChildSessionEvents: async (childSessionId) => childEvents(childSessionId),
  });

  await port.run(request());

  assert.equal(progressEvents(events).length, 0);
  // 终态仍然照常携带完整用量。
  const stopped = events.find((item) => item.type === SessionEventType.SubagentStopped);
  const payload = stopped?.payload as Record<string, unknown> | undefined;
  assert.equal(payload?.totalToolUseCount, EXPECTED_TOOL_CALL_COUNT);
});

test("累计值未变化时不重复发进度事件", async () => {
  const events: SessionEvent[] = [];
  const port = createExploreSubagentPort({
    runExploreAgent: async (child) => {
      for (let i = 0; i < 3; i += 1) {
        child.reportActivity?.();
        await settle();
        // 让节流窗口过去，逼出后续的 flush 机会。等待真实时长是这里唯一的成本，
        // 用一次跨窗口的等待就够验证「窗口内不重复、窗口外才重算」。
        if (i === 0) {
          await new Promise((resolve) => setTimeout(resolve, SUBAGENT_PROGRESS_INTERVAL_MS_TEST));
        }
      }
      return {
        response: "done",
        traceId: child.traceContext.traceId,
        events: childEvents(child.sessionId),
      };
    },
    emitParentEvent: async (event) => {
      events.push(event);
    },
    // 每次回读都是同一份事件，累计值从头到尾没变过。
    readChildSessionEvents: async (childSessionId) => childEvents(childSessionId),
  });

  await port.run(request());

  // 首拍发一次；跨过节流窗口后再触发，累计值没变所以不再发。
  assert.equal(progressEvents(events).length, 1);
});

test("子代理持续产生新工具时进度逐拍递增", async () => {
  const events: SessionEvent[] = [];
  let readCount = 0;
  const port = createExploreSubagentPort({
    runExploreAgent: async (child) => {
      for (let i = 0; i < 2; i += 1) {
        child.reportActivity?.();
        await settle();
        if (i === 0) {
          await new Promise((resolve) => setTimeout(resolve, SUBAGENT_PROGRESS_INTERVAL_MS_TEST));
        }
      }
      return {
        response: "done",
        traceId: child.traceContext.traceId,
        events: childEvents(child.sessionId),
      };
    },
    emitParentEvent: async (event) => {
      events.push(event);
    },
    // 每次回读多一条工具结果：累计值真的在涨，进度事件就该跟着涨。
    readChildSessionEvents: async (childSessionId) => {
      readCount += 1;
      const base = childEvents(childSessionId);
      if (readCount === 1) return base.slice(0, 3);
      return base;
    },
  });

  await port.run(request());

  const progress = progressEvents(events);
  assert.ok(progress.length >= 2, "累计值变化时应逐拍上报");
  const counts = progress.map((item) => {
    const payload = item.payload as Record<string, unknown>;
    return payload.totalToolUseCount;
  });
  // 数字单调不减。
  for (let i = 1; i < counts.length; i += 1) {
    assert.ok(
      (counts[i] as number) >= (counts[i - 1] as number),
      `进度不应回退：${counts[i - 1]} → ${counts[i]}`,
    );
  }
  // 最后一拍与终态一致。
  assert.equal(counts.at(-1), EXPECTED_TOOL_CALL_COUNT);
});

test("没有接 readChildSessionEvents 的注入实现不发进度事件，但终态不受影响", async () => {
  const events: SessionEvent[] = [];
  const port = createExploreSubagentPort({
    runExploreAgent: async (child) => {
      for (let i = 0; i < 3; i += 1) {
        child.reportActivity?.();
        await settle();
      }
      return {
        response: "done",
        traceId: child.traceContext.traceId,
        events: childEvents(child.sessionId),
      };
    },
    emitParentEvent: async (event) => {
      events.push(event);
    },
  });

  const output = await port.run(request());

  assert.equal(progressEvents(events).length, 0);
  assert.equal(output.status, "completed");
  assert.equal(output.totalToolUseCount, EXPECTED_TOOL_CALL_COUNT);
});

// 运行中计数必须是 scheduled 语义。只数 ToolCallResult/ToolCallError 时，
// 并行工具的数字要等到最慢那个跑完才跳——子代理界面早已出行，父状态行却不动。

/** 5 个终端已启动（Scheduled + Started），一个都还没返回。 */
function parallelPendingEvents(sessionId: string, count: number): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    const callId = `p${i + 1}`;
    events.push(
      childEvent(
        SessionEventType.ToolCallScheduled,
        {
          toolCallId: callId,
          assistantMessageId: "assistant-parallel",
          toolName: "terminal",
          input: { command: `job ${i + 1}` },
          schedule: { parallelGroups: [[callId]], executionOrder: [callId] },
        },
        1_000 + i,
        sessionId,
      ),
      childEvent(
        SessionEventType.ToolCallStarted,
        { toolCallId: callId, toolName: "terminal" },
        1_100 + i,
        sessionId,
      ),
    );
  }
  return events;
}

test("并行工具已启动但一个都没完成时，运行中计数就是全部次数", async () => {
  const events: SessionEvent[] = [];
  const port = createExploreSubagentPort({
    // 子代理还挂着：5 个终端在跑，事件流里没有任何 ToolCallResult。
    runExploreAgent: async (child) => {
      child.reportActivity?.();
      await settle();
      return {
        response: "done",
        traceId: child.traceContext.traceId,
        events: parallelPendingEvents(child.sessionId, 5),
      };
    },
    emitParentEvent: async (event) => {
      events.push(event);
    },
    readChildSessionEvents: async (childSessionId) => parallelPendingEvents(childSessionId, 5),
  });

  const output = await port.run(request());

  const progress = progressEvents(events);
  assert.ok(progress.length > 0, "工具启动后应回传进度");
  const payload = progress.at(-1)?.payload as Record<string, unknown> | undefined;
  // 核心断言：不因为「还没跑完」而少算。
  assert.equal(payload?.totalToolUseCount, 5);
  assert.equal(output.totalToolUseCount, 5);
});

test("同一 toolCallId 的多类生命周期事件只计一次", async () => {
  const sessionId = "sess-dedup";
  const events: SessionEvent[] = [
    childEvent(
      SessionEventType.ToolCallScheduled,
      { toolCallId: "c1", toolName: "terminal", input: {} },
      1_000,
      sessionId,
    ),
    childEvent(SessionEventType.ToolCallStarted, { toolCallId: "c1" }, 1_100, sessionId),
    childEvent(
      SessionEventType.ToolCallResult,
      { toolCallId: "c1", result: { success: true, content: "ok" } },
      1_200,
      sessionId,
    ),
    // 同一 id 被重复投递（replay / 冷合并场景），不应把数字抬到 2。
    childEvent(
      SessionEventType.ToolCallResult,
      { toolCallId: "c1", result: { success: true, content: "ok" } },
      1_300,
      sessionId,
    ),
    childEvent(
      SessionEventType.ToolCallScheduled,
      { toolCallId: "c2", toolName: "read", input: {} },
      1_400,
      sessionId,
    ),
  ];

  const port = createExploreSubagentPort({
    // 抛错走 recoverSubagentUsage 回读路径，才会用到兜底分支。
    runExploreAgent: async () => {
      throw new Error("child runtime crashed");
    },
    emitParentEvent: async () => {},
    readChildSessionEvents: async () => events,
  });

  const output = await port.run(request());

  // c1 的四类事件算 1 次，c2 算 1 次。
  assert.equal(output.totalToolUseCount, 2);
});

test("缺 toolCallId 的工具事件被跳过，不凑数", async () => {
  const sessionId = "sess-no-id";
  const events: SessionEvent[] = [
    childEvent(SessionEventType.ToolCallResult, { result: { success: true } }, 1_000, sessionId),
    childEvent(SessionEventType.ToolCallError, { error: "boom" }, 1_100, sessionId),
    childEvent(
      SessionEventType.ToolCallScheduled,
      { toolCallId: "", toolName: "terminal", input: {} },
      1_200,
      sessionId,
    ),
    childEvent(
      SessionEventType.ToolCallScheduled,
      { toolCallId: "c1", toolName: "terminal", input: {} },
      1_300,
      sessionId,
    ),
  ];

  const port = createExploreSubagentPort({
    runExploreAgent: async () => {
      throw new Error("child runtime crashed");
    },
    emitParentEvent: async () => {},
    readChildSessionEvents: async () => events,
  });

  const output = await port.run(request());

  // 只有 c1 可证明；无 id 的三条不猜。
  assert.equal(output.totalToolUseCount, 1);
});

test("scheduled 语义与终态语义一致：有 TurnComplete 时仍以它为准", async () => {
  const port = createExploreSubagentPort({
    runExploreAgent: async (child) => {
      // childResult.events 里有 TurnComplete，走终态分支。
      return {
        response: "done",
        traceId: child.traceContext.traceId,
        events: childEvents(child.sessionId),
      };
    },
    emitParentEvent: async () => {},
  });

  const output = await port.run(request());

  assert.equal(output.totalToolUseCount, EXPECTED_TOOL_CALL_COUNT);
});
