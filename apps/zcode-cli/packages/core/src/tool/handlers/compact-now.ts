// ============================================================
// CompactNow Tool Handler
// ============================================================
// handler 只登记强制压缩请求；真正的压缩在下一模型步的 autoCompactIfNeeded
// 边界执行（trigger=Auto / reason=ContextLimit），与上下文不足时的自动压缩同一条
// 路径、同一事件流。安全闸（disabled / not_enough_messages / circuit_breaker）
// 不被强制请求越过，见 compact/policy.ts applyForcedAutoCompactDecision。

import {
  COMPACT_NOW_TOOL_NAME,
  CompactNowInputJsonSchema,
  CompactNowInputSchema,
  CompactNowOutputJsonSchema,
  CompactNowOutputSchema,
  type CompactNowInput,
  type CompactNowOutput,
  CoreErrorType,
  createCoreError,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const COMPACT_NOW_TOOL_TIMEOUT_MS = 10_000;

function assertSessionContextPort(
  context: ToolExecutionContext,
): asserts context is ToolExecutionContext & {
  sessionContextPort: NonNullable<ToolExecutionContext["sessionContextPort"]>;
} {
  if (context.sessionContextPort) return;
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `SessionContextPort is not configured for ${COMPACT_NOW_TOOL_NAME}`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName: COMPACT_NOW_TOOL_NAME,
      },
      recoverable: false,
    },
  );
}

const compactNowHandler: ToolHandler = async (input, context) => {
  const parsed = CompactNowInputSchema.parse(input) as CompactNowInput;
  assertSessionContextPort(context);

  context.sessionContextPort.requestCompactNow();
  // instructions 只影响摘要侧重；强制压缩当前复用 autoCompact 的标准摘要路径，
  // 因此这里显式告知模型该参数尚未生效，不静默吞掉。
  return {
    accepted: true,
    message: parsed.instructions
      ? "Compaction scheduled before the next model request with a standard summary. Note: custom instructions are not applied by this path yet."
      : "Compaction scheduled before the next model request, exactly like the automatic compaction that triggers when the context approaches its limit. The conversation will be replaced by a summary.",
  } satisfies CompactNowOutput;
};

const compactNowPermission: ToolPermissionSpec = {
  permission: "compactNow",
  reason: "CompactNow rewrites the session history into a summary",
  riskLevel: "medium",
  sideEffectScope: "session",
  needsApproval: false,
  patternSources: ["toolName"],
  alwaysAllowPatternSources: ["toolName"],
  denyPriority: "beforeAsk",
};

export const compactNowToolEntry: ToolEntry = {
  capability: "Request the same compaction as context-limit auto compact, immediately",
  metadata: {
    name: COMPACT_NOW_TOOL_NAME,
    description:
      "Schedule an immediate compaction of the conversation history. Equivalent to the automatic compaction that runs when the context approaches its limit: the conversation is replaced by a summary before the next model request. Use when the user asks to compact / 上下文压缩 / 收缩上下文, or before long work when context usage is high.",
    // 会重写会话历史，不能标 readOnly；但它是维护动作，不设审批（等价于 /compact）。
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: COMPACT_NOW_TOOL_TIMEOUT_MS,
    maxOutputBytes: 4_000,
    sideEffectScope: "session",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: compactNowHandler,
  inputSchema: CompactNowInputJsonSchema,
  outputSchema: CompactNowOutputJsonSchema,
  runtimeInputSchema: CompactNowInputSchema,
  runtimeOutputSchema: CompactNowOutputSchema,
  permission: compactNowPermission,
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
    defaultMs: COMPACT_NOW_TOOL_TIMEOUT_MS,
    maxMs: COMPACT_NOW_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "CompactNow was cancelled before compaction was scheduled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
