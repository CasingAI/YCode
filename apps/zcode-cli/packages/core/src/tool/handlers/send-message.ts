import { formatParentGuideYield } from "./subagent-yield-output.js";
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
import { formatContextRemainingPercentLine } from "../../subagent/context-remaining.js";
import { parseSubagentSpawnModeLabel } from "../../subagent/worker-dispatch.js";
import { assertNotOffPeakTurn } from "./off-peak.js";

// 与 Agent 工具同一子代理的两处入口共用同一结果预算：续跑回复超限时必须持久化
// 为可恢复文件（strategy "artifact"），禁止静默截断丢尾。原因：SendMessage 按 agent_<uuid>
// 逻辑身份寻址，不能拿 sess_* 当收件人；同一结果里的 childSessionId 才是回读句柄，
// HistoryRead 凭它读子 transcript 是另一条通道，不补这段续跑文本的缺口——旧 4096/truncate
// 会把结论、<usage> 与 context_remaining_percent 在文本内一并丢掉且无恢复路径。
const MAX_SEND_MESSAGE_MODEL_BYTES = 120_000;
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
  "To switch a finished Worker's Ask/Agent mode, pass mode on this tool together with the next instruction. Omit mode to keep the current one. Do not pass mode while the Worker is still running, or to Explore / general-purpose / custom agents.",
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
  const permissionMode = parseSubagentSpawnModeLabel(parsed.mode);
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
      ...(parsed.attachments === undefined ? {} : { attachments: parsed.attachments }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
      workspaceIdentity: context.workspaceIdentity,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
      trace: resolveToolTraceContext(context),
    },
    {
      signal: context.abortSignal,
      foregroundExecution: context.subagentForegroundControl,
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
    strategy: "artifact",
    preview: {
      maxBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
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
    const continuation = result.continuation;
    const text = formatParentGuideYield(continuation) ?? continuation.content.map((block) => block.text).join("\n");
    // 失败/取消终态的正文就是 errorMessage；单独给一行 `error:` 标签，让父模型一眼看到
    // 具体原因（如网络中断的 code/provider/phase），而不是混在正文里无从区分。
    const continuationError =
      "error" in continuation &&
      typeof continuation.error === "string" &&
      continuation.error.trim().length > 0
        ? continuation.error
        : undefined;
    const remainingPercentLine = formatContextRemainingPercentLine(
      continuation.remainingPercent,
    );
    const usageLines = [
      ...(continuation.totalTokens === undefined
        ? []
        : [`subagent_tokens: ${continuation.totalTokens}`]),
      `tool_uses: ${continuation.totalToolUseCount ?? "unknown"}`,
      `duration_ms: ${continuation.totalDurationMs}`,
      ...(remainingPercentLine === undefined ? [] : [remainingPercentLine]),
    ];
    const bodyLines: string[] = [];
    if (continuationError) {
      bodyLines.push(`error: ${continuationError}`);
      if (text && text !== continuationError) bodyLines.push(text);
    } else if (text) {
      bodyLines.push(text);
    }
    return [
      `Agent ${continuation.agentId} continuation status: ${continuation.status}`,
      ...bodyLines,
      `agentId: ${continuation.agentId}`,
      ...(continuation.childSessionId ? [`childSessionId: ${continuation.childSessionId}`] : []),
      continuation.contextReset
        ? "contextReset: true (continuation will start a fresh child context)"
        : "Use SendMessage again with this agentId to continue.",
      `<usage>${usageLines.join("\n")}</usage>`,
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
