// ============================================================
// Compact Tool Handler
// ============================================================
// handler 只登记强制压缩请求；真正的压缩在下一模型步的 autoCompactIfNeeded
// 边界执行（trigger=Auto / reason=ContextLimit），与上下文不足时的自动压缩同一条
// 路径、同一事件流。安全闸（disabled / not_enough_messages / circuit_breaker）
// 不被强制请求越过，见 compact/policy.ts applyForcedAutoCompactDecision。

import {
  COMPACT_TOOL_ALIASES,
  COMPACT_TOOL_NAME,
  CompactInputJsonSchema,
  CompactInputSchema,
  CompactOutputJsonSchema,
  CompactOutputSchema,
  type CompactOutput,
  CoreErrorType,
  createCoreError,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const COMPACT_TOOL_TIMEOUT_MS = 10_000;

function assertSessionContextPort(
  context: ToolExecutionContext,
): asserts context is ToolExecutionContext & {
  sessionContextPort: NonNullable<ToolExecutionContext["sessionContextPort"]>;
} {
  if (context.sessionContextPort) return;
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `SessionContextPort is not configured for ${COMPACT_TOOL_NAME}`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName: COMPACT_TOOL_NAME,
      },
      recoverable: false,
    },
  );
}

const compactHandler: ToolHandler = async (input, context) => {
  CompactInputSchema.parse(input);
  assertSessionContextPort(context);

  context.sessionContextPort.requestCompaction();
  return { failed: false } satisfies CompactOutput;
};

const compactPermission: ToolPermissionSpec = {
  permission: "compact",
  reason: "Compact rewrites the session history into a summary",
  riskLevel: "medium",
  sideEffectScope: "session",
  needsApproval: false,
  patternSources: ["toolName"],
  alwaysAllowPatternSources: ["toolName"],
  denyPriority: "beforeAsk",
};

export const compactToolEntry: ToolEntry = {
  capability: "Request the next automatic context compaction",
  aliases: COMPACT_TOOL_ALIASES,
  metadata: {
    name: COMPACT_TOOL_NAME,
    description:
      "Request the next automatic compaction of the conversation history. The runtime owns the compaction lifecycle; this tool result does not report whether compaction has completed. Use when the user asks to compact / 上下文压缩 / 收缩上下文, or before long work when context usage is high.",
    // 会重写会话历史，不能标 readOnly；但它是维护动作，不设审批（等价于 /compact）。
    allowedInPlanMode: true,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: COMPACT_TOOL_TIMEOUT_MS,
    maxOutputBytes: 4_000,
    sideEffectScope: "session",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: compactHandler,
  inputSchema: CompactInputJsonSchema,
  outputSchema: CompactOutputJsonSchema,
  runtimeInputSchema: CompactInputSchema,
  runtimeOutputSchema: CompactOutputSchema,
  permission: compactPermission,
  resultBudget: {
    maxInlineBytes: 4_000,
    maxModelBytes: 4_000,
    strategy: "truncate",
    preview: {
      maxBytes: 4_000,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: COMPACT_TOOL_TIMEOUT_MS,
    maxMs: COMPACT_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Compact was cancelled before the compaction request was registered",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
