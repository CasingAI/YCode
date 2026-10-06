// ============================================================
// CreatePlan Tool Handler - submit plan, persist, always succeed
// ============================================================

import {
  CoreErrorType,
  CREATE_PLAN_TOOL_NAME,
  CreatePlanInputJsonSchema,
  CreatePlanInputSchema,
  CreatePlanOutputJsonSchema,
  CreatePlanOutputSchema,
  createCoreError,
  isFileSystemPortError,
  type CreatePlanInput,
  type CreatePlanOutput,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import {
  SessionEventType,
  type SessionEvent,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { writeSessionPlanFile } from "../../runtime/helpers/plan-file-continuity.js";
import { CREATE_PLAN_MODEL_INSTRUCTIONS } from "./plan-mode-prompts.js";

const MAX_PLAN_MODE_MODEL_BYTES = 100_000;

const CREATE_PLAN_DESCRIPTION = CREATE_PLAN_MODEL_INSTRUCTIONS[0];

const createPlanHandler: ToolHandler = async (input, context) => {
  const parsed = CreatePlanInputSchema.parse(input) as CreatePlanInput;

  // CreatePlan 不切档：mode 只做记录，前后一致。
  const mode = context.sessionModePort?.getMode() ?? "yolo";

  // 调用即落盘：CreatePlan 无审批门（needsApproval:false），落盘直接在 handler 内完成。
  // 任何档位都落盘，不判 mode。见 docs/specs/session-plan-files.md。
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
