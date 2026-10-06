import assert from "node:assert/strict";
import test from "node:test";
import type { MessageWithParts, SessionEvent } from "@zcode/contracts";
import { AgentType } from "@zcode/contracts";
import type { SubagentRow } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";

// 冷恢复必须重建出与直播一致的 SubagentRow.subagentType。
//
// Agent 工具的真实类型字段是 input.subagent_type，而 completed 后持久化的 output 是
// formatAgentOutputForModel 拼的人类可读文本（不是 JSON），所以 parseJsonObject 必然失败。
// 早期实现只读 output/metadata.agentType 和 input.agent/agentType，全部落空后回退到字面量
// "subagent"，UI 就把它当子智能体名渲染成「子智能体 subagent」。

const T0 = 1_700_000_000_000;
const SESSION_ID = "sess-subagent-type-hydrate";

function userMessage(): MessageWithParts {
  return {
    info: {
      id: "user-1",
      sessionID: SESSION_ID,
      role: "user",
      time: { created: T0 + 500 },
      metadata: { executionKind: "agent" },
    },
    parts: [
      {
        id: "part-user-1",
        sessionID: SESSION_ID,
        messageID: "user-1",
        type: "text",
        text: "派个子智能体去查",
      },
    ],
  } as unknown as MessageWithParts;
}

/** 与 `formatAgentOutputForModel` 同款：人类可读文本 + `agentId:` 行，绝非 JSON。 */
function humanReadableAgentOutput(): string {
  return [
    "调查 TaskOutput 等待链路",
    "",
    "status: completed",
    "agentId: agent-1 (use SendMessage with to: 'agent-1' to continue this agent)",
    "<usage>tool_uses: 3\nduration_ms: 5000</usage>",
  ].join("\n");
}

function agentToolMessage(input: Record<string, unknown>): MessageWithParts {
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
          input,
          time: { start: T0 + 1_000, end: T0 + 6_000 },
          output: humanReadableAgentOutput(),
        },
      },
    ],
  } as unknown as MessageWithParts;
}

function subagentTypeOf(projection: ProductProjection): string | undefined {
  return projection
    .getSnapshot()
    .rows.window.find((row): row is SubagentRow => row.kind === "subagent")?.subagentType;
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

test("冷恢复从 input.subagent_type 还原子智能体类型，不落回退字面量", () => {
  const projection = hydrate([
    userMessage(),
    agentToolMessage({
      description: "调查 TaskOutput 等待链路",
      prompt: "只读调查",
      subagent_type: "Explore",
    }),
  ]);

  assert.equal(subagentTypeOf(projection), "Explore");
});

test("模型省略 subagent_type 时与 Agent handler 的缺省一致（general-purpose）", () => {
  const projection = hydrate([
    userMessage(),
    agentToolMessage({ description: "随手做件事", prompt: "去做" }),
  ]);

  assert.equal(subagentTypeOf(projection), AgentType.GeneralPurpose);
  assert.notEqual(subagentTypeOf(projection), "subagent");
});

test("直播 SubagentSpawned 与 transcript 合成事件对同一类型给出同一个 subagentType", () => {
  // cold merge 会压制重复的 durable spawned，只保留 transcript 侧合成的那一对；
  // 因此这条断言锁的是「两条路径的 agentType 必须一致」，而不是谁先到。
  const liveSpawned: SessionEvent = {
    id: "event-spawned-live",
    sessionId: SESSION_ID,
    turnId: "turn-hydrate-1",
    type: "subagent_spawned",
    timestamp: new Date(T0 + 2_000),
    traceId: "trace-hydrate",
    sequenceNumber: 1,
    payload: {
      agentId: "agent-1",
      agentType: "Explore",
      childSessionId: "sess-child-1",
      description: "调查 TaskOutput 等待链路",
      parentToolCallId: "call-agent-1",
      status: "running",
    },
  } as unknown as SessionEvent;

  const liveProjection = new ProductProjection(SESSION_ID, "epoch-live");
  liveProjection.applyEvent(liveSpawned);

  assert.equal(subagentTypeOf(liveProjection), subagentTypeOf(hydrate([
    userMessage(),
    agentToolMessage({
      description: "调查 TaskOutput 等待链路",
      prompt: "只读调查",
      subagent_type: "Explore",
    }),
  ])));
});