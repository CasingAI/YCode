import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentInputJsonSchema,
  SendMessageInputJsonSchema,
  createSessionId,
  createToolCallId,
  type SubagentAttachment,
} from "@zcode/contracts";
import { createAgentToolEntry } from "../src/tool/handlers/agent.js";
import { sendMessageToolEntry } from "../src/tool/handlers/send-message.js";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { resolveTurnAttachments } from "../src/runtime/helpers/attachments.js";

// Agent 派活 / SendMessage 续聊的图片附件必须一路透传到 child executeTurn，
// 非法附件由既有 resolver 降级，不新增崩溃路径。

const IMAGE_ATTACHMENT = {
  type: "image",
  path: "/tmp/subagent-attachment-test.png",
  filename: "screenshot.png",
  mimeType: "image/png",
} as const;

function baseContext(subagentPort: unknown) {
  return {
    sessionId: createSessionId(),
    toolCallId: createToolCallId(),
    subagentPort,
  } as never;
}

test("Agent 工具把图片附件透传给 SubagentPort.run", async () => {
  let captured: SubagentAttachment[] | undefined;
  const handler = createAgentToolEntry().handler;
  await handler(
    {
      description: "look at screenshot",
      prompt: "describe the screenshot",
      attachments: [IMAGE_ATTACHMENT],
    },
    baseContext({
      run: async (request: { attachments?: SubagentAttachment[] }) => {
        captured = request.attachments;
        return { status: "completed" };
      },
    }),
  );
  assert.deepEqual(captured, [IMAGE_ATTACHMENT]);
});

test("SendMessage 工具把图片附件透传给 sendMessage", async () => {
  let captured: SubagentAttachment[] | undefined;
  await sendMessageToolEntry.handler(
    {
      to: "agent_abc",
      summary: "see screenshot",
      message: "what is in the screenshot",
      attachments: [IMAGE_ATTACHMENT],
    },
    baseContext({
      sendMessage: async (request: { attachments?: SubagentAttachment[] }) => {
        captured = request.attachments;
        return { status: "success", messageId: "msg_1" };
      },
    }),
  );
  assert.deepEqual(captured, [IMAGE_ATTACHMENT]);
});

test("无附件时请求不带 attachments 字段", async () => {
  let requestKeys: string[] = [];
  const handler = createAgentToolEntry().handler;
  await handler(
    { description: "plain task", prompt: "do it" },
    baseContext({
      run: async (request: Record<string, unknown>) => {
        requestKeys = Object.keys(request);
        return { status: "completed" };
      },
    }),
  );
  assert.equal(requestKeys.includes("attachments"), false);
});

test("终态续跑把 SendMessage 附件带进 child 执行请求", async () => {
  let childAttachments: unknown;
  const port = createExploreSubagentPort({
    runExploreAgent: async (child) => {
      childAttachments = child.attachments;
      return { response: "done", traceId: child.traceContext.traceId, events: [] };
    },
    emitParentEvent: async () => {},
  });
  assert.ok(port.sendMessage);

  // 先派活建立终态 Agent，再用 SendMessage 带附件续跑。
  const parentSessionId = createSessionId();
  const launched = await port.run({
    sessionId: parentSessionId,
    parentToolCallId: createToolCallId(),
    agentType: "general-purpose",
    description: "attachment continuation",
    prompt: "first run",
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    trace: { traceId: "trace_cont_attach" } as never,
  });
  assert.equal(launched.status, "completed");
  const agentId = (launched as { agentId: string }).agentId;
  childAttachments = undefined;

  const continued = await port.sendMessage!({
    sessionId: parentSessionId,
    parentToolCallId: createToolCallId(),
    to: agentId,
    summary: "see screenshot",
    message: "look at this",
    attachments: [{ ...IMAGE_ATTACHMENT }],
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    trace: { traceId: "trace_cont_attach_2" } as never,
  });
  assert.equal(continued.status, "success");
  assert.deepEqual(childAttachments, [{ ...IMAGE_ATTACHMENT }]);
});

test("非法图片附件降级为 placeholder，不抛错", async () => {
  const resolved = await resolveTurnAttachments(
    [{ type: "image", filename: "ghost.png" }],
    {
      workingDirectory: process.cwd(),
      traceContext: { traceId: "trace_attach_invalid" } as never,
    },
  );
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.contentBlock.type, "text");
});

test("provider schema 暴露 attachments，枚举不含 url", () => {
  const agentProps = AgentInputJsonSchema.properties as Record<string, unknown>;
  const sendProps = SendMessageInputJsonSchema.properties as Record<string, unknown>;
  assert.ok(agentProps.attachments, "Agent schema 缺少 attachments");
  assert.ok(sendProps.attachments, "SendMessage schema 缺少 attachments");
  const items = (agentProps.attachments as { items?: { properties?: { type?: { enum?: string[] } } } })
    .items;
  assert.deepEqual(items?.properties?.type?.enum, ["image", "file", "pdf"]);
});
