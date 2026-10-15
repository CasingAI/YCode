import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionId,
  createToolCallId,
  createTraceId,
  createTurnId,
} from "@zcode/contracts";
import { agentToolEntry } from "../src/tool/handlers/agent.js";
import { sendMessageToolEntry } from "../src/tool/handlers/send-message.js";
import { serializeOutput } from "../src/tool/executor/result-serialization.js";
import { executeToolCall } from "../src/tool/executor/call-runner.js";
import { BackgroundTaskTracker } from "../src/tool/executor/background-tasks.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import type { PermissionBrokerPort } from "@zcode/contracts";
import type { ToolExecutorDeps } from "../src/tool/executor/types.js";

// SendMessage 续跑回复超限时必须持久化为可恢复文件（strategy "artifact"），
// 禁止旧 4096/truncate 那样静默丢尾：agentId 是 agent_<uuid> 逻辑身份、
// 不是 sess_*，父模型无法自行重读子 transcript，截断即不可恢复。

function continuationOutput(bodyText: string, remainingPercent = 18) {
  return {
    status: "success" as const,
    messageId: "msg_1",
    agentId: "agent_abc",
    delivery: "resumed_foreground" as const,
    continuation: {
      status: "completed" as const,
      agentId: "agent_abc",
      agentType: "general-purpose",
      description: "demo",
      prompt: "do it",
      content: [{ type: "text" as const, text: bodyText }],
      totalToolUseCount: 2,
      totalDurationMs: 1000,
      totalTokens: 50,
      remainingPercent,
    },
  };
}

function depsWithStore(captured: { content?: string; retention?: unknown }) {
  return {
    sessionId: createSessionId(),
    artifactStore: {
      writeToolResultArtifact: async (request: { content: string; retention?: unknown }) => {
        captured.content = request.content;
        captured.retention = request.retention;
        return {
          id: "artifact-1",
          uri: "artifact://send-message-test-1",
          path: "/tmp/send-message-test-1.txt",
          bytes: Buffer.byteLength(request.content, "utf8"),
          contentType: "application/json",
          createdAt: new Date(),
        };
      },
    },
  } as unknown as ToolExecutorDeps;
}

function traceContext() {
  return { traceId: createTraceId(), turnId: createTurnId() };
}

// 端到端接线：真实 handler → call-runner → 模型可见内容，证明 entry 的
// resultBudget 在真实路径上生效（而非只在直调 serializeOutput 时成立）。
function e2eDeps(
  replyBody: string,
  captured: { content?: string },
): ToolExecutorDeps {
  const registry = createToolRegistry();
  registry.register(sendMessageToolEntry);
  return {
    registry,
    permissionService: new PermissionService(defaultPermissionConfig),
    permissionBroker: {
      requestPermission: async () => ({ decision: "allow" }),
    } as unknown as PermissionBrokerPort,
    emitEvent: async () => {},
    sessionId: createSessionId(),
    turnId: createTurnId(),
    defaultTimeoutMs: 5_000,
    getWorkingDirectory: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    getMode: () => "yolo",
    readFileState: new Map(),
    subagentPort: {
      sendMessage: async () => continuationOutput(replyBody),
    },
    artifactStore: {
      writeToolResultArtifact: async (request: { content: string }) => {
        captured.content = request.content;
        return {
          id: "artifact-e2e",
          uri: "artifact://send-message-e2e",
          path: "/tmp/send-message-e2e.txt",
          bytes: Buffer.byteLength(request.content, "utf8"),
          contentType: "application/json",
          createdAt: new Date(),
        };
      },
    },
  } as unknown as ToolExecutorDeps;
}

function modelTextOf(result: { modelContent?: unknown }): string {
  return typeof result.modelContent === "string" ? result.modelContent : "";
}

test("端到端：超限续跑经真实执行器持久化，常规回复内联返回", async () => {
  const tailMarker = "E2E_TAIL_端到端尾部结论";
  const bigCaptured: { content?: string } = {};
  const bigDeps = e2eDeps(`前文\n${"y".repeat(130_000)}\n${tailMarker}`, bigCaptured);
  const big = await executeToolCall(
    bigDeps,
    new BackgroundTaskTracker(bigDeps),
    {
      id: "toolu_sendmsg_e2e_big",
      name: "RelayToSubagent",
      input: { to: "agent_abc", summary: "continue task", message: "go on" },
    },
  );

  assert.equal(big.success, true);
  assert.equal(big.serialization?.budgetStrategy, "artifact");
  assert.equal(big.serialization?.truncated, true);
  assert.equal(big.serialization?.artifactPath, "/tmp/send-message-e2e.txt");
  const bigModelText = modelTextOf(big);
  assert.match(bigModelText, /<persisted-output>/);
  assert.match(bigModelText, /\/tmp\/send-message-e2e\.txt/);
  assert.doesNotMatch(bigModelText, /Tool output truncated by resultBudget/);
  // 落盘的是 handler 格式化后的全文：尾部结论与剩余百分比可恢复。
  assert.match(bigCaptured.content ?? "", new RegExp(tailMarker));
  assert.match(bigCaptured.content ?? "", /context_remaining_percent: 18/);

  // 同一真实路径：常规回复内联返回，尾部用量行不丢。
  const smallCaptured: { content?: string } = {};
  const smallDeps = e2eDeps("常规结论正文", smallCaptured);
  const small = await executeToolCall(
    smallDeps,
    new BackgroundTaskTracker(smallDeps),
    {
      id: "toolu_sendmsg_e2e_small",
      name: "RelayToSubagent",
      input: { to: "agent_abc", summary: "continue task", message: "go on" },
    },
  );

  assert.equal(small.success, true);
  assert.equal(small.serialization?.truncated, false);
  assert.equal(small.serialization?.artifactPath, undefined);
  assert.equal(smallCaptured.content, undefined);
  const smallModelText = modelTextOf(small);
  assert.match(smallModelText, /常规结论正文/);
  assert.match(smallModelText, /context_remaining_percent: 18/);
  assert.match(smallModelText, /<usage>/);
  assert.match(smallModelText, /agentId: agent_abc/);
});

test("SendMessage 结果预算与 Agent 同形：artifact 策略、上限 120_000", () => {
  const budget = sendMessageToolEntry.resultBudget;
  assert.equal(budget?.strategy, "artifact");
  assert.equal(budget?.maxInlineBytes, 120_000);
  assert.equal(budget?.maxModelBytes, 120_000);
  assert.equal(budget?.artifact?.enabled, true);
  assert.equal(budget?.artifact?.retention, "session");
  assert.equal(sendMessageToolEntry.metadata.maxOutputBytes, 120_000);
  // 同一子代理的两处入口预算一致。
  assert.equal(budget?.strategy, agentToolEntry.resultBudget?.strategy);
  assert.equal(budget?.maxModelBytes, agentToolEntry.resultBudget?.maxModelBytes);
  assert.equal(budget?.maxInlineBytes, agentToolEntry.resultBudget?.maxInlineBytes);
});

test("超限续跑回复不静默截断：持久化并返回 artifact 路径", async () => {
  const tailMarker = "TAIL_MARKER_续跑结论尾部";
  const output = continuationOutput(`前文\n${"x".repeat(130_000)}\n${tailMarker}`);
  const captured: { content?: string; retention?: unknown } = {};
  const serialization = await serializeOutput(
    depsWithStore(captured),
    output,
    sendMessageToolEntry,
    traceContext(),
    createToolCallId(),
    new AbortController().signal,
  );

  assert.equal(serialization.budgetStrategy, "artifact");
  assert.equal(serialization.truncated, true);
  assert.equal(serialization.artifactPath, "/tmp/send-message-test-1.txt");
  // 模型侧拿到 <persisted-output> 包络与可读路径，而不是截断提示。
  assert.match(serialization.content, /<persisted-output>/);
  assert.match(serialization.content, /\/tmp\/send-message-test-1\.txt/);
  assert.doesNotMatch(serialization.content, /Tool output truncated by resultBudget/);
  // 尾部结论写入文件、可恢复，而非丢弃。
  assert.match(captured.content ?? "", new RegExp(tailMarker));
  assert.match(captured.content ?? "", /context_remaining_percent: 18/);
  assert.equal(captured.retention, "session");
});

test("常规续跑回复内联返回：尾部 context_remaining_percent 不丢", async () => {
  const output = continuationOutput("结论正文");
  const deps = { sessionId: createSessionId() } as unknown as ToolExecutorDeps;
  const serialization = await serializeOutput(
    deps,
    output,
    sendMessageToolEntry,
    traceContext(),
    createToolCallId(),
    new AbortController().signal,
  );

  const inline = sendMessageToolEntry.formatModelContent?.(output);
  assert.equal(serialization.truncated, false);
  assert.equal(serialization.artifactPath, undefined);
  assert.equal(serialization.content, inline);
  assert.match(serialization.content, /context_remaining_percent: 18/);
  assert.match(serialization.content, /<usage>/);
  assert.match(serialization.content, /agentId: agent_abc/);
});
