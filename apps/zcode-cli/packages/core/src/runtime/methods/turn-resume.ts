// 同 turn 续跑（spec docs/specs/session-error-banner-continue.md §4）。
//
// 「继续」不是重发输入，而是把失败的那个 turn 原地复活：同一个 runtime turnId、同一个
// user messageId、turnNumber 不变，provider 请求前缀就是失败前那一次的原始上下文。
// 输入侧零写入 —— 不 persistUserPrompt、不发 TurnStarted、不往 messageHistory 追加 entry，
// 因此模型无从感知发生过网络问题。
//
// 需要的全部事实都在持久转录里（失败 assistant 消息的 anchor.turnId 与 parentID），
// 所以这里没有任何内存挂起态：重启、冷恢复之后照样能继续。

import {
  CoreErrorType,
  SessionEventType,
  TurnMachineImpl,
  createCoreError,
  createModelUsageSummaryFromEvents,
  runWithContextAsync,
  traceContextToLogContext,
} from "../deps.js";
import type { MessageId, MessageWithParts, SessionEvent, TraceContext, TurnId } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  appendTurnOutcomeEvent,
  createTurnAbortScope,
  createTurnFailureError,
  throwIfTurnAborted,
} from "../helpers/index.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type { ResumeTurnRuntimeCommand, TurnStartSignal } from "../command-queue.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";
import { runRegularTurnLoop } from "./turn-loop.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { applySubmissionExecutionState, createTurnModel } from "./turn-model.js";
import { recordTurnUsageFact } from "./usage-observability.js";

export interface ResumeFailedTurnOptions {
  /** 失败轮的 turnId：投影 productTurnId（持久 user messageId）或 core runtime turnId 都接受。 */
  failedTurnId: string;
  inputId?: string;
  traceContext?: TraceContext;
}

/**
 * 转录里定位失败轮的结果。
 *
 * `runtimeTurnId` 是 core 的 turn id（assistant 消息 anchor.turnId），续跑全程复用；
 * `userMessageId` 是该轮的用户消息 id，新 assistant 消息挂回它下面，时间线上仍在同一个 turn。
 */
export interface ResolvedFailedTurn {
  runtimeTurnId: TurnId;
  userMessageId: MessageId;
}

/**
 * 从持久转录反查失败轮。
 *
 * 两个入口都要认：投影 header 的 rowId 是 productTurnId（有持久 messageId 时它就是
 * user messageId），而 assistant 消息 anchor 里存的是 core runtime turnId。两条 ID 空间
 * 不同，任一命中即可定位。
 */
export function resolveFailedTurn(
  messages: readonly MessageWithParts[],
  failedTurnId: string,
): ResolvedFailedTurn | undefined {
  const userIndex = messages.findIndex((message) => message.info.id === failedTurnId);
  if (userIndex >= 0) {
    const afterUser = messages
      .slice(userIndex + 1)
      .find((message) => message.info.role === "assistant" && message.info.error);
    if (afterUser && afterUser.info.role === "assistant") {
      return failedTurnOf(afterUser);
    }
  }
  const byAnchor = messages.find(
    (message) =>
      message.info.role === "assistant" &&
      Boolean(message.info.error) &&
      message.info.anchor?.turnId === failedTurnId,
  );
  if (!byAnchor || byAnchor.info.role !== "assistant") return undefined;
  return failedTurnOf(byAnchor);
}

/**
 * 该轮续跑要复用的 turn 身份。
 *
 * 优先用 anchor 里的 runtime turnId；缺失时退回该轮的用户消息 id —— 它同样是跨进程
 * 稳定的轮身份（v4 投影的 turnHeader 就是以它为键），而且正是投影 `TurnResumed`
 * payload 里回带的那一个，两边能对上。不能凭空造一个 turnId：投影按事件 turnId 找不到
 * header，复活信号会被静默丢弃，横幅就永远消不掉。
 */
function failedTurnOf(message: MessageWithParts): ResolvedFailedTurn | undefined {
  if (message.info.role !== "assistant") return undefined;
  const runtimeTurnId = message.info.anchor?.turnId ?? message.info.parentID;
  if (!runtimeTurnId) return undefined;
  return { runtimeTurnId: runtimeTurnId as TurnId, userMessageId: message.info.parentID };
}

/**
 * 起跑信号：`TurnResumed` 落库后 resolve，让调用方不必等到整轮结束才拿到 ack。
 * 与 prompt 链路的 `sendInput` → `admission` + `completion` 同一形状。
 */
export type { TurnStartSignal } from "../command-queue.js";

export interface ResumeFailedTurnAdmission {
  /** 整轮续跑的完成 promise；只在失败时 reject（已转成 TurnError 事件，UI 走横幅）。 */
  readonly completion: Promise<void>;
}

/**
 * 续跑入口（推荐）：TurnResumed 落库即返回，调用方拿 ack；整轮跑完与否看 events。
 *
 * 与 executeTurn 走同一条 command queue：turn 的串行/admission 语义只有一份，
 * 续跑不得绕过它自己插队。
 */
export async function beginResumeFailedTurn(
  this: AgentRuntimeInternal,
  options: ResumeFailedTurnOptions,
): Promise<ResumeFailedTurnAdmission> {
  let resolveStarted: () => void = () => {};
  const startedPromise = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const completion = enqueueCancellableRuntimeCommand<void, ResumeTurnRuntimeCommand>(this, {
    createCommand: ({ reject, resolve }) => ({
      branchGeneration: this.branchGeneration,
      createdAt: new Date(),
      failedTurnId: options.failedTurnId,
      id: createRuntimeCommandId(),
      ...(options.inputId === undefined ? {} : { inputId: options.inputId }),
      mode: "resume",
      // 与其它前台命令同优先级：用户点「继续」和发新消息是同一优先级，先到先跑。
      priority: "now",
      reject,
      resolve,
      started: { promise: startedPromise, resolve: resolveStarted },
      traceContext: options.traceContext ?? this.rootTraceContext,
    }),
  });
  // 起跑前失败（命令被拒 / 旧分支丢弃）必须让调用方看见：否则 ack 回来了但什么都没跑。
  // 起跑后失败走 completion —— 那时横幅已经消失，终态由 TurnComplete/TurnError 事件表达。
  await Promise.race([
    startedPromise,
    completion.then(
      () => startedPromise,
      (error: unknown) => {
        throw error;
      },
    ),
  ]);
  return { completion };
}

export async function resumeFailedTurnCommand(
  this: AgentRuntimeInternal,
  failedTurnId: string,
  inputId: string | undefined,
  traceContext: TraceContext,
  abortSignal: AbortSignal,
  started: TurnStartSignal,
): Promise<void> {
  await runWithContextAsync(traceContext, async () => {
    const store = this.sessionStore;
    if (!store) {
      throw createCoreError(
        CoreErrorType.UnknownError,
        "Cannot resume a failed turn without a session store",
        { context: { failedTurnId, reason: "no_session_store" }, recoverable: false },
      );
    }
    const resolved = resolveFailedTurn(await store.messages({ sessionID: this.sessionId }), failedTurnId);
    if (!resolved) {
      // 不静默：UI 需要知道「继续」这次没生效（chat.error.continueFailed）。
      throw createCoreError(CoreErrorType.UnknownError, `No failed turn to resume (${failedTurnId})`, {
        context: { failedTurnId, reason: "failed_turn_not_found" },
        recoverable: false,
      });
    }

    const { runtimeTurnId, userMessageId } = resolved;
    // 续跑沿用失败轮的 turnId：事件归属、消息 anchor、状态机三者都必须是它，
    // 否则续跑产出的新消息会挂到另一个 turn 上，下一次失败就再也定位不回来。
    const turnTraceContext: TraceContext = {
      ...traceContext,
      sessionId: this.sessionId,
      turnId: runtimeTurnId,
    };
    const events: SessionEvent[] = [];
    const turnStartedAtMs = Date.now();
    const abortScope = createTurnAbortScope(abortSignal);
    const turnAbortSignal = abortScope.signal;
    const traceId = turnTraceContext.traceId;

    // 续跑不新增输入：模型请求前缀就是冷恢复后 messageHistory 里的全部内容。
    // 失败 assistant 消息已被 hydrator 丢弃（session-history-hydrator），所以这份前缀
    // 与失败前那次请求逐字相同 —— 模型无从感知发生过网络问题。
    const turnRequestEntries = [...this.messageHistory.borrowReadOnlyRuntimeEntries()];

    let admittedModel;
    try {
      admittedModel = createTurnModel(this, { selection: this.getSessionModelSelection() });
    } catch (error) {
      const coreError = createTurnFailureError(error, turnAbortSignal, "Model creation failed");
      await appendTurnOutcomeEvent(this, {
        coreError,
        events,
        durationMs: Date.now() - turnStartedAtMs,
        turnPhase: "model_creation",
        ...(inputId === undefined ? {} : { inputId }),
        traceContext: turnTraceContext,
        fallbackMessage: "Model creation failed",
        logEvent: "turn.failed",
        logLabel: "Turn resume",
      });
      throw coreError;
    }

    await this.ensureContextInitialized(turnTraceContext, admittedModel);
    throwIfTurnAborted(turnAbortSignal);

    const activeTurn = this.beginActiveTurn(runtimeTurnId, turnTraceContext, "regular", true, {
      ...(inputId === undefined ? {} : { inputId }),
    });
    // 复活信号先于任何模型事件发出：投影据此把 failed header 翻回 running 并清 lastError，
    // 横幅在续跑真正起跑前就消失，不会出现「已恢复」与「仍在报错」同时在屏的窗口。
    const resumedEvent = this.createEvent(
      SessionEventType.TurnResumed,
      { ...(inputId === undefined ? {} : { inputId }), userMessageId },
      turnTraceContext,
    );
    await this.appendEvent(resumedEvent, turnTraceContext);
    events.push(resumedEvent);
    this.logger?.info("Turn resumed in place", {
      ...traceContextToLogContext(turnTraceContext),
      event: "turn.resumed",
      failedTurnId,
      module: "core.runtime",
      status: "started",
      turnId: String(runtimeTurnId),
    });

    // 与 executeTurnCommand 同一形状：用同一个 turnId 重建状态机，turnNumber 不递增。
    const turnMachine = new TurnMachineImpl(
      TurnMachineImpl.create(this.sessionId, this.turnNumber, "", traceId, runtimeTurnId).start(),
    );

    try {
      // ack 边界：TurnResumed 已落库，横幅已消失，命令可以回了。之后的成败由
      // TurnComplete/TurnError 事件表达，不占用调用方的请求生命周期。
      started.resolve();
      const submissionModel = await applySubmissionExecutionState(
        this,
        undefined,
        turnTraceContext,
        undefined,
        admittedModel,
      );
      const loopState: RegularTurnLoopState = {
        activeTurn,
        anomalyWarningsInjected: 0,
        backgroundSubagentResultConsumed: false,
        workflowResultConsumed: false,
        currentUserMessageId: userMessageId,
        events,
        input: "",
        modelResponse: "",
        model: submissionModel ?? admittedModel,
        modelStepCount: 0,
        historyRoundCount: 0,
        reactiveCompactAttemptedInCurrentModelStep: false,
        repeatedToolCallStreakCount: 0,
        stopHookContinuationCount: 0,
        streamRecoveryRetryCount: 0,
        tokenCount: 0,
        toolCallCount: 0,
        turnRequestState: { entries: turnRequestEntries, outputTokenContinuationCount: 0 },
        traceId,
        turnAbortSignal,
        turnId: runtimeTurnId,
        turnMachine,
        turnTraceContext,
        userMessageId,
      };

      await runRegularTurnLoop.call(this, loopState);

      const turnUsage = createModelUsageSummaryFromEvents(events);
      const completeEvent = this.createEvent(
        SessionEventType.TurnComplete,
        {
          response: loopState.modelResponse,
          tokenCount: loopState.tokenCount,
          usage: turnUsage,
          toolCallCount: loopState.toolCallCount,
          historyRoundCount: loopState.historyRoundCount,
          duration: Date.now() - turnStartedAtMs,
          resultType: "success",
          ...(inputId === undefined ? {} : { inputId }),
        },
        turnTraceContext,
      );
      await this.appendEvent(completeEvent, turnTraceContext);
      events.push(completeEvent);
      await recordTurnUsageFact(this, {
        completedAt: Date.now(),
        events,
        startedAt: turnStartedAtMs,
        status: "completed",
        traceContext: turnTraceContext,
        turnId: runtimeTurnId,
        userMessageId,
      });
      // turnNumber 只在真正的新轮才递增；同 turn 续跑完成不推进轮次计数。
      await this.rebuildProjection();
    } catch (error) {
      const coreError = createTurnFailureError(error, turnAbortSignal, "Turn execution failed");
      await appendTurnOutcomeEvent(this, {
        coreError,
        events,
        durationMs: Date.now() - turnStartedAtMs,
        turnPhase: turnMachine.state.phase,
        ...(inputId === undefined ? {} : { inputId }),
        traceContext: turnTraceContext,
        fallbackMessage: "Turn execution failed",
        logEvent: "turn.failed",
        logLabel: "Turn resume",
      });
      await recordTurnUsageFact(this, {
        completedAt: Date.now(),
        error: coreError,
        events,
        startedAt: turnStartedAtMs,
        status: coreError.type === CoreErrorType.TurnCancelled ? "cancelled" : "error",
        traceContext: turnTraceContext,
        turnId: runtimeTurnId,
        userMessageId,
      });
      throw coreError;
    } finally {
      this.finishActiveTurn(activeTurn);
      abortScope.dispose();
    }
  });
}