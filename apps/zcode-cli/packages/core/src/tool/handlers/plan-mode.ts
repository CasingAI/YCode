// ============================================================
// Plan Mode Tool Handlers
// ============================================================

import {
  CoreErrorType,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  EnterPlanModeInputJsonSchema,
  EnterPlanModeInputSchema,
  EnterPlanModeOutputJsonSchema,
  EnterPlanModeOutputSchema,
  ExitPlanModeInputJsonSchema,
  ExitPlanModeInputSchema,
  ExitPlanModeOutputJsonSchema,
  ExitPlanModeOutputSchema,
  createCoreError,
  isFileSystemPortError,
  type EnterPlanModeOutput,
  type ExitPlanModeInput,
  type ExitPlanModeOutput,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import type {
  ToolBeforePermissionContext,
  ToolBeforePermissionOutcome,
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
} from "../types.js";
import { writeSessionPlanFile } from "../../runtime/helpers/plan-file-continuity.js";
import {
  ENTER_PLAN_MODE_PROVIDER_DESCRIPTION,
  createEnterPlanModeProviderDescription,
  EXIT_PLAN_MODE_MODEL_INSTRUCTIONS,
} from "./plan-mode-prompts.js";

const MAX_PLAN_MODE_MODEL_BYTES = 100_000;

const EXIT_PLAN_MODE_DESCRIPTION = EXIT_PLAN_MODE_MODEL_INSTRUCTIONS[0];

const enterPlanModeHandler: ToolHandler = async (input, context) => {
  EnterPlanModeInputSchema.parse(input);
  assertSessionModePort(context, ENTER_PLAN_MODE_TOOL_NAME);

  const transition = await context.sessionModePort.enterPlanMode({
    toolCallId: context.toolCallId,
    traceContext: {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      turnId: context.turnId,
    },
  });

  return {
    message:
      "Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.",
    mode: transition.mode,
    previousMode: transition.previousMode,
  } satisfies EnterPlanModeOutput;
};

const exitPlanModeHandler: ToolHandler = async (input, context) => {
  const parsed = ExitPlanModeInputSchema.parse(input) as ExitPlanModeInput;
  assertSessionModePort(context, EXIT_PLAN_MODE_TOOL_NAME);

  if (context.sessionModePort.getMode() !== "plan") {
    throw createCoreError(
      CoreErrorType.InvalidStateTransition,
      "You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: EXIT_PLAN_MODE_TOOL_NAME,
        },
        recoverable: true,
      },
    );
  }

  const transition = await context.sessionModePort.exitPlanMode({
    toolCallId: context.toolCallId,
    traceContext: {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      turnId: context.turnId,
    },
  });

  return {
    allowedPrompts: parsed.allowedPrompts,
    approved: true,
    mode: transition.mode,
    plan: parsed.plan,
    previousMode: transition.previousMode,
  } satisfies ExitPlanModeOutput;
};

export const enterPlanModeToolEntry: ToolEntry = {
  capability: "Enter read-only planning mode before implementation",
  requiresUserInteraction: false,
  metadata: {
    name: ENTER_PLAN_MODE_TOOL_NAME,
    description: ENTER_PLAN_MODE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    requiresUserInteraction: false,
    timeoutMs: 30000,
    maxOutputBytes: MAX_PLAN_MODE_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: enterPlanModeHandler,
  formatModelContent: formatEnterPlanModeModelContent,
  inputSchema: EnterPlanModeInputJsonSchema,
  outputSchema: EnterPlanModeOutputJsonSchema,
  runtimeInputSchema: EnterPlanModeInputSchema,
  runtimeOutputSchema: EnterPlanModeOutputSchema,
  permission: planModePermission("plan.enter", "EnterPlanMode changes session mode to plan", false),
  resultBudget: planModeResultBudget(),
  timeout: planModeTimeout(),
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "EnterPlanMode was cancelled before plan mode was entered",
  },
  trace: planModeTracePolicy(),
};

export function createEnterPlanModeToolEntry(
  options: {
    embeddedSearchEnabled?: boolean;
  } = {},
): ToolEntry {
  return {
    ...enterPlanModeToolEntry,
    metadata: {
      ...enterPlanModeToolEntry.metadata,
      description: createEnterPlanModeProviderDescription(options),
    },
  };
}

export const exitPlanModeToolEntry: ToolEntry = {
  capability: "Request user approval for the plan and exit planning mode before coding",
  requiresUserInteraction: true,
  metadata: {
    name: EXIT_PLAN_MODE_TOOL_NAME,
    description: EXIT_PLAN_MODE_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    requiresUserInteraction: true,
    timeoutMs: 30000,
    maxOutputBytes: MAX_PLAN_MODE_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: true,
  },
  handler: exitPlanModeHandler,
  beforePermission: exitPlanModeBeforePermission,
  formatModelContent: formatExitPlanModeModelContent,
  inputSchema: ExitPlanModeInputJsonSchema,
  outputSchema: ExitPlanModeOutputJsonSchema,
  runtimeInputSchema: ExitPlanModeInputSchema,
  runtimeOutputSchema: ExitPlanModeOutputSchema,
  permission: planModePermission(
    "plan.exit",
    "ExitPlanMode changes session mode after user plan approval",
  ),
  resultBudget: planModeResultBudget(),
  timeout: planModeTimeout(),
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ExitPlanMode was cancelled before plan mode was exited",
  },
  trace: planModeTracePolicy(),
};

function assertSessionModePort(
  context: ToolExecutionContext,
  toolName: typeof ENTER_PLAN_MODE_TOOL_NAME | typeof EXIT_PLAN_MODE_TOOL_NAME,
): asserts context is ToolExecutionContext & {
  sessionModePort: NonNullable<ToolExecutionContext["sessionModePort"]>;
} {
  if (context.sessionModePort) return;

  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `SessionModePort is not configured for ${toolName}`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName,
      },
      recoverable: false,
    },
  );
}

/**
 * 审批门之前落盘计划：批准与拒绝（v4 UI 的静默拒绝）两种结局下文件都已存在，
 * 压缩回注因此不依赖用户是否点了批准。见 docs/specs/session-plan-files.md。
 */
async function exitPlanModeBeforePermission(
  input: unknown,
  context: ToolBeforePermissionContext,
): Promise<ToolBeforePermissionOutcome | void> {
  // 非计划模式的调用由权限门（mode.plan.exitOnly）与 handler 的模式校验拒绝，不落盘。
  if (context.mode !== "plan") return;
  if (!context.fileSystemPort) return;

  // 输入在 validateInput 已按同一 schema 校验过；这里只对合法提交落盘。
  const parsed = ExitPlanModeInputSchema.safeParse(input);
  if (!parsed.success) return;

  try {
    const written = await writeSessionPlanFile({
      abortSignal: context.abortSignal,
      fileSystemPort: context.fileSystemPort,
      overview: parsed.data.overview,
      plan: parsed.data.plan,
      sessionId: context.sessionId,
      title: parsed.data.title,
      toolCallId: context.toolCallId,
      traceContext: context.traceContext,
      workspaceRoot: context.workspaceRoot,
    });
    // 已落盘就必须回报：这条路径是 UI 计划卡片/详情面板显示与打开计划文件的唯一来源，
    // 而拒绝路径没有工具输出可读（v4 UI 静默拒绝计划批准），丢在这里就只剩「看不到路径」。
    return { planFile: { path: written.path, planId: written.planId } };
  } catch (error) {
    if (isPlanFilePersistenceCancellation(error, context.abortSignal)) {
      throw createCoreError(
        CoreErrorType.ToolCancelled,
        "ExitPlanMode was cancelled before plan mode was exited",
        {
          cause: error instanceof Error ? error : undefined,
          context: {
            toolCallId: context.toolCallId,
            toolName: EXIT_PLAN_MODE_TOOL_NAME,
          },
          recoverable: true,
        },
      );
    }
    // 落盘失败不失败工具调用：计划文件是压缩连续性的事实，不是执行前提。
    context.logger?.warn("Failed to persist ExitPlanMode plan file", {
      event: "plan.file.persist_failed",
      module: "core.tool.plan_mode",
      status: "failed",
      toolCallId: context.toolCallId,
    });
  }
}

function isPlanFilePersistenceCancellation(error: unknown, abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted) || (isFileSystemPortError(error) && error.code === "cancelled");
}

function formatEnterPlanModeModelContent(output: unknown): string {
  const result = output as EnterPlanModeOutput;
  return `${result.message}

In plan mode, you should:
1. Thoroughly explore the codebase to understand existing patterns
2. Identify similar features and architectural approaches
3. Consider multiple approaches and their trade-offs
4. Use AskUserQuestion if you need to clarify the approach
5. Design a concrete implementation strategy
6. When ready, use ExitPlanMode to present your plan for approval

Remember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.`;
}

function formatExitPlanModeModelContent(output: unknown): string {
  const result = output as ExitPlanModeOutput;
  const plan = result.plan?.trim();
  if (!plan) {
    return "User has approved exiting plan mode. You can now proceed.";
  }

  return `User has approved your plan. You can now start coding. Start with updating your todo list if applicable.

## Approved Plan:
${plan}`;
}

function planModePermission(
  permission: string,
  reason: string,
  needsApproval = true,
): ToolPermissionSpec {
  return {
    permission,
    reason,
    riskLevel: "low" as const,
    sideEffectScope: "session" as const,
    needsApproval,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk" as const,
  };
}

function planModeResultBudget() {
  return {
    maxInlineBytes: MAX_PLAN_MODE_MODEL_BYTES,
    maxModelBytes: MAX_PLAN_MODE_MODEL_BYTES,
    strategy: "truncate" as const,
    preview: {
      maxBytes: MAX_PLAN_MODE_MODEL_BYTES,
      direction: "head" as const,
    },
  };
}

function planModeTimeout() {
  return {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  };
}

function planModeTracePolicy() {
  return {
    required: true as const,
    propagateToAdapters: false,
    recordInput: "summary" as const,
    recordOutput: "summary" as const,
  };
}
