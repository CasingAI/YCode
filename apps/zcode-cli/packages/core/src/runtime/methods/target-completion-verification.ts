import {
  SessionEventType,
  GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
  createChildTraceContext,
  failOpenGoalCompletionVerification,
  failedGoalCompletionVerification,
  formatGoalCompletionVerificationPrompt,
  parseGoalCompletionVerificationText,
  traceContextToLogContext,
} from "../deps.js";
import type {
  GoalCompletionVerificationOutput,
  SessionEvent,
  SessionGoal,
  TraceContext,
} from "../deps.js";
import {
  buildRuntimeProviderRequestMessages,
  isTurnCancellationError,
  throwIfTurnAborted,
} from "../helpers/index.js";
import { projectMessagesForModelMediaPolicy } from "../helpers/media-budget.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { isRuntimeAttachmentEntry, type RuntimeMessageEntry } from "../../agent/message-history.js";
import { createRuntimeModel } from "./runtime-model.js";
import { generateTargetCompletionVerificationText } from "./target-completion-verification-model.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { runTargetCompletionVerificationWithTelemetry } from "./target-completion-verification-telemetry.js";
import {
  admitSuccessTerminal,
  isSuccessTerminalEventCommitted,
  markSuccessTerminalCommitted,
  releaseSuccessTerminal,
  type SuccessTerminalAdmission,
} from "./success-terminal-admission.js";

export interface TargetCompletionVerificationResult {
  target: SessionGoal;
  verification: GoalCompletionVerificationOutput;
}

interface TargetCompletionVerificationExecution {
  verification: GoalCompletionVerificationOutput;
  /**
   * completed 结论的准入 token。passed 时由外层持有到 target 持久化完成；
   * notSatisfied 时 append 后立即释放，让 nextAction continuation 可停。
   */
  admission?: SuccessTerminalAdmission;
}

export async function verifyActiveTargetCompletionForContinuation(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    target: SessionGoal;
    traceContext: TraceContext;
  },
): Promise<TargetCompletionVerificationResult | null> {
  if (this.config.targetCompletionVerification?.enabled === false) return null;
  if (!this.sessionStore) return null;
  if (input.target.status !== "active") return null;

  const execute = async (): Promise<TargetCompletionVerificationResult> => {
    const events: SessionEvent[] = [];
    const outcome = await verifyTargetCompletion.call(this, {
      abortSignal: input.abortSignal,
      events,
      target: input.target,
      traceContext: input.traceContext,
    });
    const { verification } = outcome;

    if (!verification.passed) {
      // notSatisfied 也是一次 completed 结论，但后面没有 target 持久化；
      // append 完成后立即释放，nextAction continuation 才能重新被 Stop。
      releaseSuccessTerminal(outcome.admission);
      return {
        target: input.target,
        verification,
      };
    }

    try {
      const previousTarget = await this.readSessionTargetForContext(input.traceContext);
      const completedTarget =
        (await this.sessionStore!.updateTargetStatus({
          sessionID: this.sessionId,
          status: "complete",
        })) ?? input.target;
      await this.recordTargetChanged({
        action: "status_updated",
        previousTarget,
        source: "runtime",
        target: completedTarget,
        traceContext: input.traceContext,
      });

      return {
        target: completedTarget,
        verification,
      };
    } finally {
      // passed 结论的锁必须覆盖 target 持久化，之后才允许 Stop 命中后续工作。
      releaseSuccessTerminal(outcome.admission);
    }
  };
  return runTargetCompletionVerificationWithTelemetry(this, input, execute);
}

async function verifyTargetCompletion(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    target: SessionGoal;
    traceContext: TraceContext;
  },
): Promise<TargetCompletionVerificationExecution> {
  // 目标验证期间也允许切换 session 默认模型；请求、重试和 usage 必须共用
  // 验证开始时的模型快照，不能在 provider 返回后重新读取 Session Selection。
  const requestedModelSelection = this.getSessionModelSelection();
  const model = createRuntimeModel(this, { selection: requestedModelSelection });
  const modelTraceContext = createChildTraceContext(input.traceContext, {
    attributes: {
      model: `${model.providerId}/${model.modelId}`,
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      targetId: input.target.targetID,
    },
  });
  const verificationId = modelTraceContext.spanId ?? modelTraceContext.traceId;
  const foregroundExecutionId = this.activeForegroundExecution?.foregroundExecutionId;
  const goalIteration = await getNextTargetCompletionVerificationIteration.call(
    this,
    input.target.targetID,
  );
  const anchor = targetCompletionVerificationAnchor.call(this, input.traceContext);
  await this.appendEvent(
    this.createEvent(
      SessionEventType.TargetCompletionVerification,
      {
        ...anchor,
        ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
        goalIteration,
        status: "started",
        targetId: input.target.targetID,
        verificationId,
      },
      modelTraceContext,
    ),
    modelTraceContext,
  );
  const providerMessages = buildRuntimeProviderRequestMessages(this, {
    entries: [
      ...withoutTrailingPendingAssistantToolCallEntries(
        this.messageHistory.borrowReadOnlyRuntimeEntries(),
      ),
      {
        message: {
          role: "user" as const,
          content: formatGoalCompletionVerificationPrompt(input.target),
        },
      },
    ],
    applyCacheControl: true,
    model,
  }).messages;
  // verifier 直接消费完整历史但曾绕过正常请求的媒体策略；只补 capability
  // 仍会让聚合超限失败进入 fail-open。请求前统一执行能力和预算投影。
  const messages = projectMessagesForModelMediaPolicy(
    providerMessages,
    model.properties.inputFormat,
  ).messages;
  const modelRequestEvent = this.createEvent(
    SessionEventType.ModelRequest,
    {
      messages,
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      toolCount: 0,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelRequestEvent, modelTraceContext);
  input.events.push(modelRequestEvent);
  const modelStartedAt = Date.now();
  const networkEventStartIndex = input.events.length;
  let completedEvent: SessionEvent | undefined;
  let completedAdmission: SuccessTerminalAdmission | undefined;

  try {
    const result = await generateTargetCompletionVerificationText.call(this, {
      abortSignal: input.abortSignal,
      events: input.events,
      messages,
      model,
      traceContext: modelTraceContext,
    });
    throwIfTurnAborted(input.abortSignal);
    const toolCalls = this.extractToolCallsFromResult(result);
    const modelCompleteEvent = this.createEvent(
      SessionEventType.ModelComplete,
      {
        content: result.text,
        querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
        stopReason: result.finishReason,
        toolCallCount: toolCalls.length,
        usage: result.usage,
      },
      modelTraceContext,
    );
    await this.appendEvent(modelCompleteEvent, modelTraceContext);
    input.events.push(modelCompleteEvent);
    await recordModelUsageFact(this, {
      events: input.events,
      model,
      networkEventStartIndex,
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      result,
      startedAt: modelStartedAt,
      status: "completed",
      toolCallCount: toolCalls.length,
      traceContext: modelTraceContext,
    });
    const verification =
      toolCalls.length > 0
        ? failOpenGoalCompletionVerification(
            "The completion verifier attempted to call tools instead of returning a verification result.",
          )
        : parseGoalCompletionVerificationText(result.text);
    completedEvent = this.createEvent(
      SessionEventType.TargetCompletionVerification,
      {
        ...anchor,
        ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
        goalIteration,
        status: "completed",
        targetId: input.target.targetID,
        verification,
        verificationId,
      },
      modelTraceContext,
    );
    // passed 与 notSatisfied 都是 completed 结论：append 前同步检查取消并锁定。
    // Stop 在 ModelComplete/usage await 期间到达时，这里会抛出取消，走 catch 的
    // cancelled 路径，而不是把已停止的验证写成 completed。
    completedAdmission = admitSuccessTerminal.call(this, input.abortSignal);
    await this.appendEvent(completedEvent, modelTraceContext);
    markSuccessTerminalCommitted(completedAdmission);
    return { verification, admission: completedAdmission };
  } catch (error) {
    const admitted = completedAdmission;
    const successCommitted = admitted
      ? admitted.committed ||
        (await isSuccessTerminalEventCommitted.call(this, completedEvent, input.events, error))
      : false;
    if (admitted) {
      releaseSuccessTerminal(admitted);
      completedAdmission = undefined;
    }
    if (successCommitted) {
      // completed 结论已经进入权威事件流，不能再追加 cancelled/failed_closed。
      // 后续真实故障保留原错误与日志，由调用方按已完成结论处理。
      this.logger?.error(
        "Goal completion verification failed after completed event commit",
        error instanceof Error ? error : new Error(String(error)),
        {
          ...traceContextToLogContext(modelTraceContext),
          event: "target.completion_verification.success_commit.post_failure",
          module: "core.runtime",
          status: "failed",
          targetId: input.target.targetID,
        },
      );
      throw error;
    }
    // 准入前后是取消判定的分界：
    // - 还没有成功准入时，Stop 已被当前 foreground controller 接受就必须 cancelled，
    //   即使模型随后抛的是普通 Error；external fault 仍由 isTurnCancellationError 优先排除。
    // - 已准入但未提交时，任何此时才到达的 abort 都是晚到 parent abort，不能把真实故障
    //   伪装成用户取消。
    const activeExecution = this.activeForegroundExecution;
    const sameForegroundExecution =
      foregroundExecutionId !== undefined &&
      activeExecution?.foregroundExecutionId === foregroundExecutionId;
    const preAdmissionAbortSignal = input.abortSignal?.aborted
      ? input.abortSignal
      : sameForegroundExecution
        ? activeExecution?.controller.signal
        : input.abortSignal;
    const cancelled = isTurnCancellationError(
      error,
      admitted ? undefined : preAdmissionAbortSignal,
    );
    await recordModelUsageFact(this, {
      error,
      events: input.events,
      model,
      networkEventStartIndex,
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      startedAt: modelStartedAt,
      status: cancelled ? "cancelled" : "error",
      traceContext: modelTraceContext,
    });
    if (cancelled) {
      const preserveQueueAutoDrainOnCancel =
        this.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
      await this.appendEvent(
        this.createEvent(
          SessionEventType.TargetCompletionVerification,
          {
            ...anchor,
            ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
            goalIteration,
            status: "cancelled",
            targetId: input.target.targetID,
            ...(preserveQueueAutoDrainOnCancel ? { preserveQueueAutoDrainOnCancel: true } : {}),
            verification: failedGoalCompletionVerification(
              "Completion verifier request was cancelled.",
            ),
            verificationId,
          },
          modelTraceContext,
        ),
        modelTraceContext,
      );
      // 用户 Stop 或队列“立即发送”打断 goal verifier 时，当前没有普通
      // executeTurn 的取消收口路径会暂停 target。如果仍保持 active，后续
      // resumeSession + sendPrompt 会被 agent 当成 goal continuation，普通用户消息会继续输出 checkpoint。
      await this.pauseActiveTargetForCancellation(modelTraceContext);
      throw error;
    }
    this.logger?.warn("Goal completion verification failed open", {
      ...traceContextToLogContext(modelTraceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.completion_verification.failed_open",
      module: "core.runtime",
      status: "failed",
      targetId: input.target.targetID,
    });
    const verification = failOpenGoalCompletionVerification(
      error instanceof Error
        ? `Completion verifier request failed: ${error.message}`
        : "The completion verifier could not confirm that every goal requirement is complete.",
    );
    await this.appendEvent(
      this.createEvent(
        SessionEventType.TargetCompletionVerification,
        {
          ...anchor,
          ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
          goalIteration,
          status: "failed_closed",
          targetId: input.target.targetID,
          verification,
          verificationId,
        },
        modelTraceContext,
      ),
      modelTraceContext,
    );
    return { verification };
  }
}

function targetCompletionVerificationAnchor(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): { anchorAssistantMessageId?: string; anchorTurnId?: string } {
  const anchorAssistantMessageId = this.latestAssistantMessageId;
  const anchorTurnId = this.latestAssistantTurnId ?? traceContext.turnId;
  return {
    ...(anchorAssistantMessageId ? { anchorAssistantMessageId } : {}),
    ...(anchorTurnId ? { anchorTurnId } : {}),
  };
}

async function getNextTargetCompletionVerificationIteration(
  this: AgentRuntimeInternal,
  targetId: string,
): Promise<number> {
  const projection = await this.rebuildProjection();
  const targetTimeline = projection.targetCompletionVerificationTimeline.filter(
    (item) => item.targetId === targetId,
  );
  const latestIteration = targetTimeline.reduce(
    (maxIteration, item, index) => Math.max(maxIteration, item.goalIteration ?? index + 1),
    0,
  );
  // goal 迭代由 verifier lifecycle 推进，而不是普通 turn 或用户继续次数。
  // runtime 在 started/completed/failed_closed/cancelled 上固定同一个编号，UI 与 snapshot 才不会各自猜。
  return latestIteration + 1;
}

function withoutTrailingPendingAssistantToolCallEntries(
  entries: readonly RuntimeMessageEntry[],
): readonly RuntimeMessageEntry[] {
  const last = entries.at(-1);
  if (
    !last ||
    isRuntimeAttachmentEntry(last) ||
    last?.message.role !== "assistant" ||
    !last.message.toolCalls ||
    last.message.toolCalls.length === 0
  ) {
    return entries;
  }
  return entries.slice(0, -1);
}
