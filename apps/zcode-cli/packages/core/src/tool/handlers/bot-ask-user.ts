import {
  BOT_ASK_USER_TOOL_NAME,
  BotAskUserAnsweredInputSchema,
  BotAskUserInputJsonSchema,
  BotAskUserInputSchema,
  BotAskUserOutputJsonSchema,
  BotAskUserOutputSchema,
  CoreErrorType,
  createCoreError,
  type BotAskUserOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const BOT_ASK_USER_DESCRIPTION = [
  "Ask the user one single-choice question with at most two buttons.",
  "Use this only when you need a decision. Everyday talk uses bot_send_message.",
  "Do not use AskUserQuestion. The answer appears in this Bot conversation, not a system card.",
].join("\n");

const botAskUserHandler: ToolHandler = async (input, context) => {
  const parsed = BotAskUserAnsweredInputSchema.safeParse(input);
  if (!parsed.success) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "bot_ask_user requires the user's selected button before execution",
      {
        recoverable: true,
        context: {
          toolCallId: context.toolCallId,
          toolName: BOT_ASK_USER_TOOL_NAME,
        },
      },
    );
  }
  const selected = parsed.data.choices.find((choice) => choice.id === parsed.data.selectedId);
  if (!selected) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "bot_ask_user selectedId is not a choice", {
      recoverable: true,
      context: { selectedId: parsed.data.selectedId },
    });
  }
  return {
    text: parsed.data.text,
    selectedId: selected.id,
    selectedLabel: selected.label,
  } satisfies BotAskUserOutput;
};

export const botAskUserToolEntry: ToolEntry = {
  capability: "Ask the user a two-button question in a Bot job session",
  requiresUserInteraction: true,
  metadata: {
    name: BOT_ASK_USER_TOOL_NAME,
    description: BOT_ASK_USER_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    requiresUserInteraction: true,
    timeoutMs: 30_000,
    maxOutputBytes: 4_000,
    sideEffectScope: "userInteraction",
    riskLevel: "low",
    needsApproval: true,
  },
  handler: botAskUserHandler,
  inputSchema: BotAskUserInputJsonSchema,
  outputSchema: BotAskUserOutputJsonSchema,
  runtimeInputSchema: BotAskUserInputSchema,
  runtimeOutputSchema: BotAskUserOutputSchema,
  permission: {
    permission: "userInteraction.botAskUser",
    reason: "bot_ask_user pauses for a single in-conversation choice",
    riskLevel: "low",
    sideEffectScope: "userInteraction",
    needsApproval: true,
    patternSources: ["toolName", "input"],
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
    defaultMs: 30_000,
    maxMs: 30_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "bot_ask_user was cancelled before a choice was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
