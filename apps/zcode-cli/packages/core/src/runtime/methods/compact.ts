import {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  CoreErrorType,
  DEFAULT_COMPACT_CONTEXT_WINDOW,
  SessionEventType,
  createModelUsageSummaryFromEvents,
  runWithContextAsync,
  traceContextToLogContext,
  estimateMessageTokens,
  hasEnoughMessagesToCompact,
  shouldAutoCompact,
  applyForcedAutoCompactDecision,
} from "../deps.js";
import type {
  AutoCompactPolicyConfig,
  AutoCompactTokenOverride,
  SessionEvent,
  TraceContext,
  TurnId,
} from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  throwIfTurnAborted,
  createTurnFailureError,
  isTurnCancellationError,
  appendTurnOutcomeEvent,
  buildRuntimeProviderRequestMessages,
} from "../helpers/index.js";
import type { TurnResult, RunModelTextRequestOptions } from "../types.js";
import type { Model } from "../deps.js";
import type { ProviderContextUsageSnapshot } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { autoCompactDecisionLogContext } from "./compact-log-context.js";
import { resolveNormalRequestMaxOutputTokens } from "./model-token-limits.js";
import type {
  AutoCompactLoopContext,
  AutoCompactOutcome,
  CompactAttemptOutcome,
  ReactiveCompactLoopContext,
} from "./turn-loop-state.js";
import { recordTurnUsageFact } from "./usage-observability.js";
import { findLatestCommittedAssistantUsage } from "./turn-model-step-usage.js";
import {
  admitSuccessTerminal,
  isSuccessTerminalEventCommitted,
  markSuccessTerminalCommitted,
  releaseSuccessTerminal,
} from "./success-terminal-admission.js";
import type { SuccessTerminalAdmission } from "./success-terminal-admission.js";

export async function executeManualCompact(
  this: AgentRuntimeInternal,
  input: string,
  customInstructions: string | undefined,
  turnId: TurnId,
  turnTraceContext: TraceContext,
  abortSignal?: AbortSignal,
  inputId?: string,
  model?: Model,
): Promise<TurnResult> {
  const events: SessionEvent[] = [];
  const startedAt = Date.now();
  const activeTurn = this.beginActiveTurn(turnId, turnTraceContext, "compact", false);
  // 手动 /compact 复用前台回合入口，成功终态同样走准入仲裁。准入不等于提交：
  // 收口时必须用 token 的 committed 或权威事件流回查区分，避免双重终态。
  let successTerminalAdmission: SuccessTerminalAdmission | undefined;
  let successTerminalEvent: SessionEvent | undefined;
  return runWithContextAsync(turnTraceContext, async () => {
    this.logger?.info("Compact started", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.started",
      inputLength: input.length,
      module: "core.runtime",
      status: "started",
    });

    await this.ensureSessionPersisted(input, turnTraceContext);

    const turnStartedEvent = this.createEvent(
      SessionEventType.TurnStarted,
      {
        turnNumber: this.turnNumber,
        input,
        inputId,
        // 手动 /compact 是维护命令，不是用户真实 query。
        // 事件仍保留 raw input 便于恢复/排查，但 v4 投影不能把它渲染成 user bubble。
        inputVisibility: "model-only",
      },
      turnTraceContext,
    );
    await this.appendEvent(turnStartedEvent, turnTraceContext);
    events.push(turnStartedEvent);

    try {
      throwIfTurnAborted(abortSignal);
      const compactResult = await this.compactActiveConversation(
        customInstructions,
        turnTraceContext,
        events,
        {
          abortSignal,
          compactReason: CompactReason.UserRequested,
          phase: CompactPhase.StandaloneTurn,
          ...(inputId ? { sourceCommandId: inputId } : {}),
          ...(model ? { model } : {}),
        },
      );
      throwIfTurnAborted(abortSignal);

      const turnUsage = createModelUsageSummaryFromEvents(events);
      const completeEvent = this.createEvent(
        SessionEventType.TurnComplete,
        {
          response: compactResult.displayText,
          tokenCount: compactResult.tokenCount,
          usage: turnUsage,
          toolCallCount: 0,
          historyRoundCount: 1,
          duration: Date.now() - startedAt,
          resultType: "success",
          cacheStats: this.messageHistory.getCacheStats(),
          inputId,
        },
        turnTraceContext,
      );
      // 准入紧邻成功事件 append：此同步步之后到达的 stop 只能 noop；
      // 准入锁覆盖 usage/rebuild 等收尾，避免这些 await 期间被停止改写。
      successTerminalEvent = completeEvent;
      const successAdmission = admitSuccessTerminal.call(this, abortSignal);
      successTerminalAdmission = successAdmission;
      await this.appendEvent(completeEvent, turnTraceContext);
      markSuccessTerminalCommitted(successAdmission);
      events.push(completeEvent);
      await recordTurnUsageFact(this, {
        completedAt: Date.now(),
        events,
        startedAt,
        status: "completed",
        traceContext: turnTraceContext,
        turnId,
      });

      this.turnNumber++;
      const projection = await this.rebuildProjection();
      this.logger?.info("Compact completed", {
        ...traceContextToLogContext(turnTraceContext),
        durationMs: Date.now() - startedAt,
        event: "compact.completed",
        module: "core.runtime",
        status: "completed",
      });

      return {
        response: compactResult.displayText,
        turnId,
        traceId: turnTraceContext.traceId,
        usage: turnUsage,
        events,
        projection,
      };
    } catch (error) {
      const admitted = successTerminalAdmission;
      // 准入不等于提交：append 可能已进 eventStore 却在 notify 阶段拒绝。
      // 只有权威事件流里确实存在成功事件时才禁止第二个终态。
      const successCommitted = admitted
        ? admitted.committed ||
          (await isSuccessTerminalEventCommitted.call(this, successTerminalEvent, events, error))
        : false;
      if (successCommitted) {
        const coreError = createTurnFailureError(error, abortSignal, "Compact failed", {
          ignoreAbortedSignal: true,
        });
        // 成功终态已提交，后续 usage/rebuild 故障不能再写 cancelled/TurnError；
        // 保留真实错误日志并向上抛出，由调用方按已完成的维护轮次处理。
        this.logger?.error("Compact failed after success terminal commit", coreError, {
          ...traceContextToLogContext(turnTraceContext),
          event: "compact.success_commit.post_failure",
          module: "core.runtime",
          status: "failed",
        });
        throw coreError;
      }
      if (admitted) {
        // 仅准入、未提交：释放锁后仍走真实故障收口，避免 append 完全失败时无终态。
        releaseSuccessTerminal(admitted);
        successTerminalAdmission = undefined;
      }
      const coreError = createTurnFailureError(
        error,
        abortSignal,
        "Compact failed",
        admitted ? { ignoreAbortedSignal: true } : undefined,
      );
      const preserveQueueAutoDrainOnCancel =
        coreError.type === CoreErrorType.TurnCancelled &&
        this.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
      if (coreError.type === CoreErrorType.TurnCancelled && !preserveQueueAutoDrainOnCancel) {
        // Stop compact 与普通 Stop 语义一致：队列重新暂停，外层 FIFO 恢复窗口同时关闭。
        this.queueAutoDrain = false;
        this.queueExternalDrainActive = false;
      }
      await appendTurnOutcomeEvent(this, {
        coreError,
        events,
        durationMs: Date.now() - startedAt,
        turnPhase: "compact",
        inputId,
        traceContext: turnTraceContext,
        fallbackMessage: "Compact failed",
        logEvent: "compact.failed",
        logLabel: "Compact",
        preserveQueueAutoDrainOnCancel,
      });
      await recordTurnUsageFact(this, {
        completedAt: Date.now(),
        error: coreError,
        events,
        startedAt,
        status: coreError.type === CoreErrorType.TurnCancelled ? "cancelled" : "error",
        traceContext: turnTraceContext,
        turnId,
      });

      throw coreError;
    }
  }).finally(() => {
    // 必须在 executeManualCompact 返回前释放，后续 continuation 才能重新被 Stop。
    releaseSuccessTerminal(successTerminalAdmission);
    this.finishActiveTurn(activeTurn);
  });
}

export async function autoCompactIfNeeded(
  this: AgentRuntimeInternal,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  abortSignal: AbortSignal | undefined,
  context: AutoCompactLoopContext,
): Promise<AutoCompactOutcome> {
  throwIfTurnAborted(abortSignal);

  const config: AutoCompactPolicyConfig = {
    contextWindow: context.model.properties.contextWindow,
    ...this.config.compact,
    maxOutputTokens: resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: context.model.optionSpecs.maxOutputTokens.max,
    }),
    modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
  };
  const activeEntries = context.turnRequestState.entries;
  const activeProjection = buildRuntimeProviderRequestMessages(this, {
    entries: activeEntries,
    applyCacheControl: false,
    model: context.model,
  });
  const { messages: activeMessages, sourceEntries } = activeProjection;
  const tokenOverride = buildProviderUsageTokenOverride(activeMessages, sourceEntries);
  const rawDecision = shouldAutoCompact({
    messages: activeMessages,
    config,
    consecutiveFailures: this.autoCompactConsecutiveFailures,
    tokenOverride,
  });
  // Compact 工具的强制请求：读即清、一次性。只翻转 below_threshold，
  // 安全闸（disabled / not_enough_messages / circuit_breaker）不被越过。
  const decision = applyForcedAutoCompactDecision(
    rawDecision,
    this.consumePendingToolCompactRequest(),
  );

  if (!decision.shouldCompact) {
    this.logger?.debug("Auto compact skipped", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.auto.skipped",
      module: "core.runtime",
      compactReason: context.compactReason,
      modelStepIndex: context.modelStepIndex,
      phase: context.phase,
      reason: decision.reason,
      ...autoCompactDecisionLogContext(decision),
    });
    return "skipped";
  }

  if (context.rapidRefill.shouldBlock) {
    this.logger?.warn("Autocompact rapid-refill breaker tripped", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.rapid_refill_breaker",
      compactReason: context.compactReason,
      consecutiveRapidRefills: context.rapidRefill.consecutiveRapidRefills,
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      phase: context.phase,
      status: "failed",
      toolTurnsSinceCompact: context.rapidRefill.toolTurnsSinceCompact,
      trigger: CompactTrigger.Auto,
      ...autoCompactDecisionLogContext(decision),
    });
    return "rapid_refill_blocked";
  }

  this.logger?.info("Auto compact started", {
    ...traceContextToLogContext(turnTraceContext),
    event: "compact.auto.started",
    compactReason: context.compactReason,
    modelStepIndex: context.modelStepIndex,
    module: "core.runtime",
    phase: context.phase,
    ...autoCompactDecisionLogContext(decision),
  });

  try {
    const compactResult = await this.compactActiveConversation(
      undefined,
      turnTraceContext,
      events,
      {
        abortSignal,
        compactContextTelemetry: {
          inputTokens: decision.tokenCount,
          policyContextWindowTokens: decision.contextWindow,
          thresholdTokens: decision.threshold,
          tokenSource: decision.tokenSource,
        },
        autoCompactThreshold: decision.threshold,
        compactReason: context.compactReason,
        phase: context.phase,
        trigger: CompactTrigger.Auto,
        activeEntries,
        ...(context.model ? { model: context.model } : {}),
      },
    );
    if (compactResult.outcome === "skipped") {
      return "skipped";
    }
    context.turnRequestState.entries = compactResult.entries;
    this.autoCompactConsecutiveFailures = 0;
    this.logger?.info("Auto compact completed", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.auto.completed",
      compactReason: context.compactReason,
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      phase: context.phase,
      ...autoCompactDecisionLogContext(decision),
    });
    return "compacted";
  } catch (error) {
    if (isTurnCancellationError(error, abortSignal)) {
      throw error;
    }
    this.autoCompactConsecutiveFailures++;
    this.logger?.warn("Auto compact failed", {
      ...traceContextToLogContext(turnTraceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "compact.auto.failed",
      failureCount: this.autoCompactConsecutiveFailures,
      compactReason: context.compactReason,
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      phase: context.phase,
      ...autoCompactDecisionLogContext(decision),
    });
    return "failed";
  }
}

function buildProviderUsageTokenOverride(
  messages: RunModelTextRequestOptions["messages"],
  sourceEntries: readonly (RuntimeMessageEntry | undefined)[],
): AutoCompactTokenOverride | undefined {
  const latestUsage = findLatestCommittedAssistantUsage(sourceEntries);
  if (!latestUsage || latestUsage.messageIndex >= messages.length) {
    return undefined;
  }

  const { baseline, messageIndex } = latestUsage;
  const incrementalStartIndex =
    baseline.contextUsageTokens === undefined ? messageIndex : messageIndex + 1;
  const incrementalTokenCount = estimateMessageTokens(messages.slice(incrementalStartIndex));
  // usage 归属于已提交 assistant，反向扫描可随 history replacement 自然移动，
  // 不再依赖可能失效的绝对 message cursor。若 output 是否存在已被历史归一化抹平，
  // 则 provider input 只覆盖 assistant 之前的请求，assistant 本身仍进入本地增量。
  const providerBaseTokenCount = baseline.contextUsageTokens ?? baseline.inputTokens;
  return {
    baseTokenCount: providerBaseTokenCount,
    cacheReadTokens: baseline.cacheReadTokens,
    cacheWriteTokens: baseline.cacheWriteTokens,
    contextUsageTokenCount: baseline.contextUsageTokens,
    incrementalTokenCount,
    outputTokens: baseline.outputTokens,
    source: "provider_usage",
    tokenCount: providerBaseTokenCount + incrementalTokenCount,
  };
}

export function estimateCurrentModelInputTokens(
  messages: RunModelTextRequestOptions["messages"],
  sourceEntries: readonly (RuntimeMessageEntry | undefined)[] = [],
): number {
  return (
    buildProviderUsageTokenOverride(messages, sourceEntries)?.tokenCount ??
    estimateMessageTokens(messages)
  );
}

/**
 * GetContextUsage 的数据源：与 autoCompactIfNeeded 完全同口径——同一 config 构造、
 * 同一 provider usage 反推（buildProviderUsageTokenOverride），差别只在消息源用已提交的
 * message history（工具调用时点没有 turnRequestState 可用；与 PreRequest 时点口径一致）。
 */
export function estimateAutoCompactContextUsage(
  this: AgentRuntimeInternal,
  model: Model,
): {
  config: AutoCompactPolicyConfig;
  tokenCount: number;
  tokenSource: "estimate" | "provider_usage";
} {
  const config: AutoCompactPolicyConfig = {
    contextWindow: model.properties.contextWindow,
    ...this.config.compact,
    maxOutputTokens: resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: model.optionSpecs.maxOutputTokens.max,
    }),
    modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
  };
  const entries = this.messageHistory.borrowReadOnlyRuntimeEntries();
  const projection = buildRuntimeProviderRequestMessages(this, {
    entries,
    applyCacheControl: false,
    model,
  });
  const tokenOverride = buildProviderUsageTokenOverride(
    projection.messages,
    projection.sourceEntries,
  );
  return {
    config,
    tokenCount: tokenOverride?.tokenCount ?? estimateMessageTokens(projection.messages),
    tokenSource: tokenOverride?.source ?? "estimate",
  };
}

export async function reactiveCompactAfterContextExceeded(
  this: AgentRuntimeInternal,
  originalError: unknown,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  abortSignal: AbortSignal | undefined,
  context: ReactiveCompactLoopContext,
): Promise<CompactAttemptOutcome> {
  throwIfTurnAborted(abortSignal);

  if (this.config.compact?.enabled === false) {
    this.logger?.warn("Reactive compact skipped because compact is disabled", {
      ...traceContextToLogContext(turnTraceContext),
      errorMessage: originalError instanceof Error ? originalError.message : String(originalError),
      event: "compact.reactive.skipped",
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      rapidRefillCount: context.rapidRefillCount,
      reason: "disabled",
    });
    return "skipped";
  }

  const activeEntries = context.activeEntries ?? context.turnRequestState.entries;
  const activeProjection = buildRuntimeProviderRequestMessages(this, {
    entries: activeEntries,
    applyCacheControl: false,
    model: context.model,
  });
  const { messages: activeMessages, sourceEntries } = activeProjection;
  if (!hasEnoughMessagesToCompact(activeMessages)) {
    this.logger?.warn("Reactive compact skipped because there is not enough history", {
      ...traceContextToLogContext(turnTraceContext),
      errorMessage: originalError instanceof Error ? originalError.message : String(originalError),
      event: "compact.reactive.skipped",
      messageCount: activeMessages.length,
      modelStepIndex: context?.modelStepIndex,
      module: "core.runtime",
      rapidRefillCount: context?.rapidRefillCount,
      reason: "not_enough_messages",
    });
    return "skipped";
  }

  const tokenOverride = buildProviderUsageTokenOverride(activeMessages, sourceEntries);
  const contextWindow = context.model.properties.contextWindow;

  this.logger?.warn("Reactive compact started after model context overflow", {
    ...traceContextToLogContext(turnTraceContext),
    errorMessage: originalError instanceof Error ? originalError.message : String(originalError),
    event: "compact.reactive.started",
    messageCount: activeMessages.length,
    modelStepIndex: context?.modelStepIndex,
    module: "core.runtime",
    rapidRefillCount: context?.rapidRefillCount,
    tokenCount: estimateMessageTokens(activeMessages),
  });

  try {
    const compactResult = await this.compactActiveConversation(
      undefined,
      turnTraceContext,
      events,
      {
        abortSignal,
        compactContextTelemetry: {
          inputTokens: tokenOverride?.tokenCount ?? estimateMessageTokens(activeMessages),
          policyContextWindowTokens:
            contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0
              ? Math.floor(contextWindow)
              : DEFAULT_COMPACT_CONTEXT_WINDOW,
          tokenSource: tokenOverride?.source ?? "estimate",
        },
        compactReason: CompactReason.ProviderOverflow,
        initialPromptTooLongCause: originalError,
        phase: CompactPhase.Reactive,
        trigger: CompactTrigger.Reactive,
        activeEntries,
        model: context.model,
      },
    );
    if (compactResult.outcome === "skipped") {
      return "skipped";
    }
    context.turnRequestState.entries = compactResult.entries;
    this.autoCompactConsecutiveFailures = 0;
    this.logger?.info("Reactive compact completed; retrying model request", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.reactive.completed",
      modelStepIndex: context?.modelStepIndex,
      module: "core.runtime",
      rapidRefillCount: context?.rapidRefillCount,
    });
    return "compacted";
  } catch (error) {
    if (isTurnCancellationError(error, abortSignal)) {
      throw error;
    }
    this.autoCompactConsecutiveFailures++;
    this.logger?.warn("Reactive compact failed after model context overflow", {
      ...traceContextToLogContext(turnTraceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "compact.reactive.failed",
      failureCount: this.autoCompactConsecutiveFailures,
      modelStepIndex: context?.modelStepIndex,
      module: "core.runtime",
      rapidRefillCount: context?.rapidRefillCount,
    });
    return "failed";
  }
}
