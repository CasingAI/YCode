import {
  BOT_SEND_MESSAGE_TOOL_NAME,
  BotSendMessageInputJsonSchema,
  BotSendMessageInputSchema,
  BotSendMessageOutputJsonSchema,
  BotSendMessageOutputSchema,
  CoreErrorType,
  createCoreError,
  type BotSendMessageOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const BOT_SEND_MESSAGE_DESCRIPTION = [
  "Send a short visible message to the user in this Bot job session.",
  "Plain assistant text is not shown. You MUST call this tool to speak.",
  "Call this before Agent/Task/bot_task on every turn that needs a spoken reply.",
  "Aim for about 120 characters. Hard cap is 1000.",
].join("\n");

const botSendMessageHandler: ToolHandler = async (input) => {
  const parsed = BotSendMessageInputSchema.safeParse(input);
  if (!parsed.success) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "bot_send_message requires text", {
      recoverable: true,
      context: { issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }
  return {
    delivered: true,
    text: parsed.data.text,
  } satisfies BotSendMessageOutput;
};

export const botSendMessageToolEntry: ToolEntry = {
  capability: "Deliver a short visible message to the user in a Bot job session",
  metadata: {
    name: BOT_SEND_MESSAGE_TOOL_NAME,
    description: BOT_SEND_MESSAGE_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 10_000,
    maxOutputBytes: 4_000,
    sideEffectScope: "userInteraction",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: botSendMessageHandler,
  inputSchema: BotSendMessageInputJsonSchema,
  outputSchema: BotSendMessageOutputJsonSchema,
  runtimeInputSchema: BotSendMessageInputSchema,
  runtimeOutputSchema: BotSendMessageOutputSchema,
  permission: {
    permission: "userInteraction.botSendMessage",
    reason: "bot_send_message only posts a short visible bubble",
    riskLevel: "low",
    sideEffectScope: "userInteraction",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 4_000,
    maxModelBytes: 4_000,
    strategy: "truncate",
    preview: { maxBytes: 4_000, direction: "head" },
  },
  timeout: {
    defaultMs: 10_000,
    maxMs: 10_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "bot_send_message was cancelled before delivery",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
