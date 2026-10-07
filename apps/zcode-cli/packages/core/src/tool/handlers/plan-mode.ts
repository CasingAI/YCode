// ============================================================
// Plan Mode Tool Handlers - EnterPlanMode switches mode, CreatePlan submits plan
// ============================================================

import {
  CoreErrorType,
  CREATE_PLAN_TOOL_NAME,
  CreatePlanInputJsonSchema,
  CreatePlanInputSchema,
  CreatePlanOutputJsonSchema,
  CreatePlanOutputSchema,
  ENTER_PLAN_MODE_TOOL_NAME,
  EnterPlanModeInputJsonSchema,
  EnterPlanModeInputSchema,
  EnterPlanModeOutputJsonSchema,
  EnterPlanModeOutputSchema,
  createCoreError,
  isFileSystemPortError,
  type CreatePlanInput,
  type CreatePlanOutput,
  type EnterPlanModeOutput,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import {
  SessionEventType,
  type SessionEvent,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler, ToolHandlerFailure } from "../types.js";
import { writeSessionPlanFile } from "../../runtime/helpers/plan-file-continuity.js";
import {
  CREATE_PLAN_MODEL_INSTRUCTIONS,
  ENTER_PLAN_MODE_MODEL_INSTRUCTIONS,
} from "./plan-mode-prompts.js";

const MAX_PLAN_MODE_MODEL_BYTES = 100_000;

const CREATE_PLAN_DESCRIPTION = CREATE_PLAN_MODEL_INSTRUCTIONS[0];
const ENTER_PLAN_MODE_DESCRIPTION = ENTER_PLAN_MODE_MODEL_INSTRUCTIONS[0];

// CreatePlan 越界调用的可读错误码：handler 返回值失败（非抛错），
// 走 <tool_use_error> 通道回模型，不进 permissionDenial、不贴 failed 徽标。
export const CREATE_PLAN_PLAN_MODE_ONLY_ERROR_CODE = 4001;
export const ENTER_PLAN_MODE_ALREADY_IN_PLAN_ERROR_CODE = 4002;

const CREATE_PLAN_PLAN_MODE_ONLY_MESSAGE =
  "CreatePlan is Plan-mode only, call EnterPlanMode first then retry submitting the plan.";
const ENTER_PLAN_MODE_ALREADY_IN_PLAN_MESSAGE =
  "Already in plan mode. Submit the plan with CreatePlan directly.";

const enterPlanModeHandler: ToolHandler = async (input, context) => {
  EnterPlanModeInputSchema.parse(input);
  const sessionModePort = context.sessionModePort;
  if (!sessionModePort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `SessionModePort is not configured for ${ENTER_PLAN_MODE_TOOL_NAME}`,
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: ENTER_PLAN_MODE_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const mode = sessionModePort.getMode();
  // Plan 档内再调是无操作：返回可读错误指引直接调 CreatePlan，不抛权限拒绝。
  if (mode === "plan") {
    return {
      result: false,
      errorCode: ENTER_PLAN_MODE_ALREADY_IN_PLAN_ERROR_CODE,
      message: ENTER_PLAN_MODE_ALREADY_IN_PLAN_MESSAGE,
    } satisfies ToolHandlerFailure;
  }

  const transition = await sessionModePort.enterPlanMode({
    toolCallId: context.toolCallId,
    traceContext: context.traceContext
      ? {
          traceId: context.traceContext.traceId,
          spanId: context.spanId,
          parentSpanId: context.parentSpanId,
          turnId: context.turnId,
        }
      : undefined,
  });

  return {
    message:
      "Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.",
    mode: transition.mode,
    previousMode: transition.previousMode,
  } satisfies EnterPlanModeOutput;
};

export const enterPlanModeToolEntry: ToolEntry = {
  capability: "Enter read-only planning mode before implementation",
  requiresUserInteraction: false,
  metadata: {
    name: ENTER_PLAN_MODE_TOOL_NAME,
    description: ENTER_PLAN_MODE_DESCRIPTION,
    // 显式的非破坏性会话控制动作：与 CreatePlan 同口径走 checkReadOnlyScope 的
    // explicitSessionCapability 分支放行，全档可见。
    allowedInPlanMode: true,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    requiresUserInteraction: false,
    timeoutMs: 30000,
    maxOutputBytes: MAX_PLAN_MODE_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: enterPlanModeHandler,
  formatModelContent: formatEnterPlanModeModelContent,
  inputSchema: EnterPlanModeInputJsonSchema,
  outputSchema: EnterPlanModeOutputJsonSchema,
  runtimeInputSchema: EnterPlanModeInputSchema,
  runtimeOutputSchema: EnterPlanModeOutputSchema,
  permission: planModePermission(
    "plan.enter",
    "EnterPlanMode changes session mode to plan",
    false,
  ),
  resultBudget: planModeResultBudget(),
  timeout: planModeTimeout(),
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "EnterPlanMode was cancelled before plan mode was entered",
  },
  trace: planModeTracePolicy(),
};

const createPlanHandler: ToolHandler = async (input, context) => {
  const parsed = CreatePlanInputSchema.parse(input) as CreatePlanInput;

  // CreatePlan 不切档：mode 只做记录，前后一致。
  const mode = context.sessionModePort?.getMode() ?? "yolo";

  // CreatePlan 收归 Plan 专属：非 Plan 档不落盘，返回可读错误指引模型
  // 先调 EnterPlanMode 再重试。走 handler 返回值失败（非抛错），不进
  // permissionDenial、不贴 failed 徽标。见 docs/specs/plan-card-execute.md。
  if (mode !== "plan") {
    return {
      result: false,
      errorCode: CREATE_PLAN_PLAN_MODE_ONLY_ERROR_CODE,
      message: CREATE_PLAN_PLAN_MODE_ONLY_MESSAGE,
    } satisfies ToolHandlerFailure;
  }

  // 调用即落盘：CreatePlan 无审批门（needsApproval:false），落盘直接在 handler 内完成。
  // 仅 Plan 档落盘：非 Plan 档在上面已返回可读错误。见 docs/specs/session-plan-files.md。
  // 落盘失败不失败工具调用：计划文件是压缩连续性的事实，不是执行前提。
  // 用户取消（abort）时抛 ToolCancelled。
  if (context.fileSystemPort) {
    try {
      const written = await writeSessionPlanFile({
        abortSignal: context.abortSignal,
        fileSystemPort: context.fileSystemPort,
        overview: parsed.overview,
        plan: parsed.plan,
        sessionId: context.sessionId,
        title: parsed.title,
        toolCallId: context.toolCallId,
        traceContext: context.traceContext,
        workspaceRoot: context.workspaceRoot,
      });
      // 已落盘就必须回报：这条路径是 UI 计划卡片/详情面板显示与打开计划文件的唯一来源。
      // handler 不自造事件信封（session/turn/trace/sequence 只有执行器知道），只经 emitEvent
      // 发裸事实，由 call-runner 统一发布点补信封（见下面 handler 后的 emitPlanFileWritten 调用处）。
      // 失败只记 warn（ToolExecutionContext 无 logger 通道，静默跳过由执行器侧兜底）。
      await context.emitEvent?.({
        id: crypto.randomUUID() as any,
        sessionId: context.sessionId,
        turnId: context.turnId,
        type: SessionEventType.PlanFileWritten,
        timestamp: new Date(),
        traceId: context.traceId,
        sequenceNumber: 0,
        payload: {
          planFilePath: written.path,
          planId: written.planId,
          toolCallId: context.toolCallId,
        },
      } satisfies SessionEvent);
    } catch (error) {
      if (isPlanFilePersistenceCancellation(error, context.abortSignal)) {
        throw createCoreError(
          CoreErrorType.ToolCancelled,
          "CreatePlan was cancelled before the plan was submitted",
          {
            cause: error instanceof Error ? error : undefined,
            context: {
              toolCallId: context.toolCallId,
              toolName: CREATE_PLAN_TOOL_NAME,
            },
            recoverable: true,
          },
        );
      }
      // 落盘失败只吞掉：工具调用照常成功返回，压缩连续性缺这一份而已。
    }
  }

  return {
    approved: false,
    mode,
    plan: parsed.plan,
    previousMode: mode,
  } satisfies CreatePlanOutput;
};

export const createPlanToolEntry: ToolEntry = {
  capability: "Submit a plan for user review on the plan card",
  requiresUserInteraction: false,
  metadata: {
    name: CREATE_PLAN_TOOL_NAME,
    description: CREATE_PLAN_DESCRIPTION,
    // 计划提交是显式的非破坏性会话控制动作：permission 侧 sideEffectScope 为 session
    //（见下面的 planModePermission），needsApproval 为 false，与 respond-to-coordinator、
    // compact 同口径走 checkReadOnlyScope 的 explicitSessionCapability 分支放行。
    // 门禁本身（mode.plan.nonReadOnly）不动，Write/Edit 照旧被拒。
    allowedInPlanMode: true,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    requiresUserInteraction: false,
    timeoutMs: 30000,
    maxOutputBytes: MAX_PLAN_MODE_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: createPlanHandler,
  formatModelContent: formatCreatePlanModelContent,
  inputSchema: CreatePlanInputJsonSchema,
  outputSchema: CreatePlanOutputJsonSchema,
  runtimeInputSchema: CreatePlanInputSchema,
  runtimeOutputSchema: CreatePlanOutputSchema,
  permission: planModePermission(
    "plan.create",
    "CreatePlan submits a plan for user review without switching session mode",
    false,
  ),
  resultBudget: planModeResultBudget(),
  timeout: planModeTimeout(),
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "CreatePlan was cancelled before the plan was submitted",
  },
  trace: planModeTracePolicy(),
};

function isPlanFilePersistenceCancellation(error: unknown, abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted) || (isFileSystemPortError(error) && error.code === "cancelled");
}

function formatEnterPlanModeModelContent(output: unknown): string {
  return (output as EnterPlanModeOutput).message;
}

function formatCreatePlanModelContent(output: unknown): string {
  const result = output as CreatePlanOutput;
  const plan = result.plan?.trim();
  if (!plan) {
    return "Plan created. Waiting for user approval on the plan card.";
  }

  return `Plan created. Waiting for user approval on the plan card. Do not start implementing until the user clicks "Execute plan".

## Submitted Plan:
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
