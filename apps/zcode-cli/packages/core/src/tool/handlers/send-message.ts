import {
  CoreErrorType,
  SEND_MESSAGE_TOOL_NAME,
  SendMessageInputJsonSchema,
  SendMessageInputSchema,
  SendMessageOutputSchema,
  createCoreError,
  type SendMessageInput,
  type SendMessageOutput,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { assertNotOffPeakTurn } from "./off-peak.js";

const MAX_SEND_MESSAGE_MODEL_BYTES = 4096;
const OFF_PEAK_SEND_MESSAGE_HINT =
  "Finish the current foreground continuation instead of starting a detached background Agent.";

const SEND_MESSAGE_PROVIDER_DESCRIPTION = [
  "# SendMessage",
  "",
  "Send a message to another agent.",
  "",
  "```json",
  '{"to": "agent_<uuid>", "summary": "assign task 1", "message": "start on task #1"}',
  "```",
  "",
  "Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool. Messages from agents are delivered automatically; you don't check an inbox. Use the stable `agentId` returned by Agent; running agents are steered and terminal agents continue in the foreground.",
].join("\n");

const SEND_MESSAGE_TOOL_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
  additionalProperties: false,
};

const sendMessageHandler: ToolHandler = async (input, context) => {
  const parsed = SendMessageInputSchema.parse(input) as SendMessageInput;
  assertNotOffPeakTurn(context, SEND_MESSAGE_TOOL_NAME, {
    hint: OFF_PEAK_SEND_MESSAGE_HINT,
    recoverable: true,
  });

  if (!context.subagentPort?.sendMessage) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Subagent port is not configured for SendMessage",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: SEND_MESSAGE_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  return context.subagentPort.sendMessage(
    {
      sessionId: context.sessionId,
      turnId: context.turnId,
      parentToolCallId: context.toolCallId,
      to: parsed.to,
      summary: parsed.summary,
      message: parsed.message,
       workspaceIdentity: context.workspaceIdentity,
       workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
      trace: resolveToolTraceContext(context),
    },
    {
      signal: context.abortSignal,
      ...(context.model ? { model: context.model } : {}),
      ...(context.subagentModelOverride
        ? { modelOverride: context.subagentModelOverride }
        : {}),
    },
  ) satisfies Promise<SendMessageOutput>;
};

export const sendMessageToolEntry: ToolEntry = {
  capability: "Send a short message to a local agent",
  metadata: {
    name: SEND_MESSAGE_TOOL_NAME,
    description: SEND_MESSAGE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: undefined,
    maxOutputBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: sendMessageHandler,
  formatModelContent: formatSendMessageModelContent,
  inputSchema: SendMessageInputJsonSchema,
  outputSchema: SEND_MESSAGE_TOOL_OUTPUT_SCHEMA,
  runtimeInputSchema: SendMessageInputSchema,
  runtimeOutputSchema: SendMessageOutputSchema,
  permission: {
    permission: "agent.message.send",
    reason: "SendMessage writes a message to a local agent queue",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
    maxModelBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: { kind: "none" },
  cancellation: {
    supported: true,
    cleanup: "none",
    joinOnCancel: true,
    userVisibleMessage: "SendMessage was cancelled before delivery status returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatSendMessageModelContent(output: unknown): string {
  const result = SendMessageOutputSchema.parse(output);
  if (result.continuation) {
    const text = result.continuation.content.map((block) => block.text).join("\n");
    return [
      `Agent ${result.continuation.agentId} continuation status: ${result.continuation.status}`,
      text,
      `agentId: ${result.continuation.agentId}`,
      result.continuation.contextReset
        ? "contextReset: true (continuation will start a fresh child context)"
        : "Use SendMessage again with this agentId to continue.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (result.message) return result.message;
  if (result.status === "success") {
    if (result.delivery) {
      return `Message ${result.messageId} was ${result.delivery} for local agent ${result.agentId ?? result.taskId ?? "unknown"}.`;
    }
    return `Message ${result.messageId} was queued for local agent ${result.agentId ?? result.taskId ?? "unknown"}.`;
  }
  return `Message ${result.messageId} failed to send to local agent ${result.agentId ?? result.taskId ?? "unknown"}: ${result.error ?? "unknown error"}.`;
}

function resolveToolTraceContext(context: Parameters<ToolHandler>[1]): TraceContext {
  return (
    context.traceContext ?? {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    }
  );
}
