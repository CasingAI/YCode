import assert from "node:assert/strict";
import test from "node:test";
import { agentToolEntry } from "../src/tool/handlers/agent.js";
import { sendMessageToolEntry } from "../src/tool/handlers/send-message.js";
import { formatTaskNotification } from "../src/runtime-task/notification.js";
import {
  formatContextRemainingPercentLine,
  formatContextRemainingPercentXml,
} from "../src/subagent/context-remaining.js";

const completedAgentOutput = {
  status: "completed" as const,
  agentId: "agent_1",
  childSessionId: "sess_child",
  canContinue: true,
  agentType: "general-purpose",
  description: "demo",
  prompt: "do it",
  content: [{ type: "text" as const, text: "hello" }],
  totalToolUseCount: 2,
  totalDurationMs: 1000,
  totalTokens: 50,
};

test("剩余百分比缺席不投影，0% 是真实满窗", () => {
  assert.equal(formatContextRemainingPercentLine(undefined), undefined);
  assert.equal(formatContextRemainingPercentLine(Number.NaN), undefined);
  assert.equal(formatContextRemainingPercentLine(0), "context_remaining_percent: 0");
  assert.equal(formatContextRemainingPercentLine(42.5), "context_remaining_percent: 42.5");
  assert.equal(
    formatContextRemainingPercentXml(42.5),
    "<context_remaining_percent>42.5</context_remaining_percent>",
  );
});

test("Agent 模型可见尾部用量块多一行剩余百分比，不含剩余 token", () => {
  const withPercent = agentToolEntry.formatModelContent?.({
    ...completedAgentOutput,
    remainingPercent: 42.5,
  });
  assert.match(withPercent ?? "", /context_remaining_percent: 42\.5/);
  assert.doesNotMatch(withPercent ?? "", /remaining_tokens|remainingTokens/);
  assert.match(withPercent ?? "", /subagent_tokens: 50/);

  const missing = agentToolEntry.formatModelContent?.(completedAgentOutput) ?? "";
  assert.doesNotMatch(missing, /context_remaining_percent/);
});

test("SendMessage 续跑尾部补上同一形状的剩余百分比", () => {
  const formatted = sendMessageToolEntry.formatModelContent?.({
    status: "success",
    messageId: "msg_1",
    agentId: "agent_1",
    delivery: "resumed_foreground",
    continuation: {
      ...completedAgentOutput,
      remainingPercent: 18,
    },
  });
  assert.match(formatted ?? "", /context_remaining_percent: 18/);
  assert.match(formatted ?? "", /<usage>/);
  assert.doesNotMatch(formatted ?? "", /remaining_tokens|remainingTokens/);
});

test("本地子代理通知用量标签带剩余百分比，缺席不谎报 0", () => {
  const withPercent = formatTaskNotification({
    agentId: "agent_1",
    description: "demo",
    outputFile: "/tmp/out",
    status: "completed",
    summary: "done",
    taskId: "agent_1",
    taskType: "local_agent",
    usage: {
      durationMs: 1000,
      totalTokens: 50,
      remainingPercent: 42.5,
    },
  });
  assert.match(withPercent, /<context_remaining_percent>42\.5<\/context_remaining_percent>/);

  const missing = formatTaskNotification({
    agentId: "agent_1",
    description: "demo",
    outputFile: "/tmp/out",
    status: "completed",
    summary: "done",
    taskId: "agent_1",
    taskType: "local_agent",
    usage: {
      durationMs: 1000,
      totalTokens: 50,
    },
  });
  assert.doesNotMatch(missing, /context_remaining_percent/);
});
