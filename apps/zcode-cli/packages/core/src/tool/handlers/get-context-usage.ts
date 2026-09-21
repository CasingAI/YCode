// ============================================================
// GetContextUsage Tool Handler
// ============================================================
// 口径与 auto compact 决策完全一致（见 docs/specs/session-context-tools.md）：
// used 优先取 provider usage 反推，分母是扣除 output reserve 后的 effective window。

import {
  GET_CONTEXT_USAGE_TOOL_NAME,
  CoreErrorType,
  createCoreError,
  GetContextUsageInputJsonSchema,
  GetContextUsageInputSchema,
  GetContextUsageOutputJsonSchema,
  GetContextUsageOutputSchema,
  type GetContextUsageOutput,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const GET_CONTEXT_USAGE_TOOL_TIMEOUT_MS = 10_000;
const GET_CONTEXT_USAGE_MODEL_BYTES = 4_000;

function assertSessionContextPort(
  context: ToolExecutionContext,
): asserts context is ToolExecutionContext & {
  sessionContextPort: NonNullable<ToolExecutionContext["sessionContextPort"]>;
} {
  if (context.sessionContextPort) return;
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `SessionContextPort is not configured for ${GET_CONTEXT_USAGE_TOOL_NAME}`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName: GET_CONTEXT_USAGE_TOOL_NAME,
      },
      recoverable: false,
    },
  );
}

const getContextUsageHandler: ToolHandler = async (input, context) => {
  GetContextUsageInputSchema.parse(input);
  assertSessionContextPort(context);

  const snapshot = context.sessionContextPort.getContextUsage();
  return {
    contextWindowTokens: snapshot.contextWindowTokens,
    effectiveContextWindowTokens: snapshot.effectiveContextWindowTokens,
    autocompactThresholdTokens: snapshot.autocompactThresholdTokens,
    usedTokens: snapshot.usedTokens,
    remainingTokens: snapshot.remainingTokens,
    usedPercent: snapshot.usedPercent,
    remainingPercent: snapshot.remainingPercent,
    tokenSource: snapshot.tokenSource,
  } satisfies GetContextUsageOutput;
};

const getContextUsagePermission: ToolPermissionSpec = {
  permission: "contextUsage.read",
  reason: "GetContextUsage only reads the current context window usage",
  riskLevel: "low",
  sideEffectScope: "none",
  needsApproval: false,
  patternSources: ["toolName"],
  alwaysAllowPatternSources: ["toolName"],
  denyPriority: "beforeAsk",
};

export const getContextUsageToolEntry: ToolEntry = {
  capability: "Report remaining context window tokens and percentage",
  metadata: {
    name: GET_CONTEXT_USAGE_TOOL_NAME,
    description:
      "Get the current context window usage with the same accounting the automatic compaction uses: used tokens, remaining tokens, remaining percentage, and the auto-compact threshold. Read-only.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: GET_CONTEXT_USAGE_TOOL_TIMEOUT_MS,
    maxOutputBytes: GET_CONTEXT_USAGE_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: getContextUsageHandler,
  inputSchema: GetContextUsageInputJsonSchema,
  outputSchema: GetContextUsageOutputJsonSchema,
  runtimeInputSchema: GetContextUsageInputSchema,
  runtimeOutputSchema: GetContextUsageOutputSchema,
  permission: getContextUsagePermission,
  resultBudget: {
    maxInlineBytes: GET_CONTEXT_USAGE_MODEL_BYTES,
    maxModelBytes: GET_CONTEXT_USAGE_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: GET_CONTEXT_USAGE_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: GET_CONTEXT_USAGE_TOOL_TIMEOUT_MS,
    maxMs: GET_CONTEXT_USAGE_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "GetContextUsage was cancelled before usage was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
