import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type MessageWithParts, type SessionEvent } from "@zcode/contracts";
import type { SubagentRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";

// 冷恢复必须重建与直播一致的工作段用量：Agent tool output 里的合计字段
// 要透传到合成的 SubagentStopped，再由投影合并进 TurnWorkSegment.usage。
// 缺字段的老 transcript 不补 0。

const T0 = 1_700_000_000_000;
const SESSION_ID = "sess-subagent-usage-hydrate";

function userMessage(): MessageWithParts {
  return {
    info: {
      id: "user-1",
      sessionID: SESSION_ID,
      role: "user",
      time: { created: T0 + 500 },
      // agent 轮次才有工作段，executionKind 决定 header 是否带 workSegments。
      metadata: { executionKind: "agent" },
    },
    parts: [
      {
        id: "part-user-1",
        sessionID: SESSION_ID,
        messageID: "user-1",
        type: "text",
        text: "派个 subagent 去做",
      },
    ],
  } as unknown as MessageWithParts;
}

function agentToolMessage(output: Record<string, unknown>): MessageWithParts {
  return {
    info: {
      id: "assistant-agent-1",
      sessionID: SESSION_ID,
      role: "assistant",
      time: { created: T0 + 1_000 },
    },
    parts: [
      {
        id: "part-agent-1",
        sessionID: SESSION_ID,
        messageID: "assistant-agent-1",
        type: "tool",
        callID: "call-agent-1",
        tool: "Agent",
        state: {
          status: "completed",
          input: { description: "子任务", prompt: "去做" },
          time: { start: T0 + 1_000, end: T0 + 6_000 },
          output: JSON.stringify({
            status: "completed",
            agentId: "agent-1",
            agentType: "general-purpose",
            description: "子任务",
            prompt: "去做",
            childSessionId: "sess-child-1",
            content: [{ type: "text", text: "子任务完成" }],
            totalDurationMs: 5_000,
            ...output,
          }),
        },
      },
    ],
  } as unknown as MessageWithParts;
}

function hydrate(messages: MessageWithParts[]): ProductProjection {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  for (const event of synthesizeEventsFromMessages(messages, {
    sessionId: SESSION_ID,
    baseTimestampMs: T0,
  }) as SessionEvent[]) {
    projection.applyEvent(event);
  }
  return projection;
}

function subagentUsageOf(projection: ProductProjection): SubagentRow["usage"] {
  return projection
    .getSnapshot()
    .rows.window.find((row): row is SubagentRow => row.kind === "subagent")?.usage;
}

function segmentUsageOf(projection: ProductProjection) {
  return projection
    .getSnapshot()
    .rows.window.find((row): row is TurnHeaderRow => row.kind === "turnHeader")?.workSegments?.[0]
    ?.usage;
}

test("冷恢复把 Agent output 的合计用量透传到 SubagentRow.usage", () => {
  const projection = hydrate([
    userMessage(),
    agentToolMessage({ totalToolUseCount: 3, totalReasoningDurationMs: 20_000 }),
  ]);

  assert.deepEqual(subagentUsageOf(projection), {
    toolCallCount: 3,
    reasoningDurationMs: 20_000,
  });
});

test("冷恢复的子代理用量与直播同值：父段合计 = 委派本身 1 次 + child 3 次", () => {
  const projection = hydrate([
    userMessage(),
    agentToolMessage({ totalToolUseCount: 3, totalReasoningDurationMs: 20_000 }),
  ]);

  assert.equal(segmentUsageOf(projection)?.toolCallCount, 4);
  assert.equal(segmentUsageOf(projection)?.reasoningDurationMs, 20_000);
});

test("老 transcript 没有用量字段时不伪造 0，父段只统计可证明的委派本身", () => {
  const projection = hydrate([userMessage(), agentToolMessage({})]);

  assert.equal(subagentUsageOf(projection), undefined);
  assert.equal(segmentUsageOf(projection)?.toolCallCount, 1);
  assert.equal(segmentUsageOf(projection)?.reasoningDurationMs, 0);
});

test("非法用量字段（负数 / null）被忽略，不写进 usage", () => {
  const projection = hydrate([
    userMessage(),
    // JSON.stringify 会把 NaN/Infinity 变成 null，所以这里直接注入各类的原始形状。
    agentToolMessage({ totalToolUseCount: -3, totalReasoningDurationMs: null }),
  ]);

  assert.equal(subagentUsageOf(projection), undefined);
});

test("只有一半用量字段时不补 0，整条 usage 缺席", () => {
  const projection = hydrate([userMessage(), agentToolMessage({ totalToolUseCount: 3 })]);

  assert.equal(subagentUsageOf(projection), undefined);
  // 父段仍能证明委派本身这一次工具调用。
  assert.equal(segmentUsageOf(projection)?.toolCallCount, 1);
});

test("冷恢复时间戳倒挂：行早于段 startedAt 仍归首段，用量不被丢掉", () => {
  // 合成事件用「基准时间 + seq」，可能早于用户消息时间，也就是早于段 startedAt。
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  for (const event of synthesizeEventsFromMessages([userMessage(), agentToolMessage({})], {
    sessionId: SESSION_ID,
    // 基准时间远早于消息时间，人为制造倒挂。
    baseTimestampMs: T0 - 60_000,
  }) as SessionEvent[]) {
    projection.applyEvent(event);
  }

  assert.equal(segmentUsageOf(projection)?.toolCallCount, 1);
});

test("冷恢复的合成事件确实带上了用量字段，直播与恢复走同一条数据", () => {
  const events = synthesizeEventsFromMessages(
    [agentToolMessage({ totalToolUseCount: 2, totalReasoningDurationMs: 4_000 })],
    { sessionId: SESSION_ID, baseTimestampMs: T0 },
  ) as SessionEvent[];
  const stopped = events.find((event) => event.type === SessionEventType.SubagentStopped);
  const payload = stopped?.payload as Record<string, unknown> | undefined;

  assert.equal(payload?.totalToolUseCount, 2);
  assert.equal(payload?.totalReasoningDurationMs, 4_000);
});
