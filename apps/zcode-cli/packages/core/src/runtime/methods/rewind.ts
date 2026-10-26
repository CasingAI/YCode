import {
  CoreErrorType,
  RewindScope,
  RewindStrategy,
  SessionEventType,
  createModelUsageSummaryFromEvents,
  createMessageId,
  parseWorkspaceCheckpointArtifact,
  evaluateRewindTarget,
  runWithContextAsync,
  traceContextToLogContext,
} from "../deps.js";
import type {
  SessionEvent,
  TraceContext,
  TurnId,
  CheckpointCreatedPayload,
  RewindTargetEvaluation,
  WorkspaceCheckpointArtifact,
} from "../deps.js";
import {
  selectCheckpointForRewind,
  buildRewindEvaluationItems,
  formatWorkspaceRewindNoticeBody,
  formatUnavailableRewindResponse,
  throwIfTurnAborted,
  createTurnFailureError,
  createTurnCancelledError,
  isTurnCancellationError,
  appendTurnOutcomeEvent,
} from "../helpers/index.js";
import type { TurnResult, WorkspaceRewindResult, ParsedRewindCommand } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { recordTurnUsageFact } from "./usage-observability.js";
import {
  admitSuccessTerminal,
  isSuccessTerminalEventCommitted,
  markSuccessTerminalCommitted,
  releaseSuccessTerminal,
} from "./success-terminal-admission.js";
import type { SuccessTerminalAdmission } from "./success-terminal-admission.js";

export async function executeRewindCommand(
  this: AgentRuntimeInternal,
  input: string,
  command: ParsedRewindCommand,
  turnId: TurnId,
  turnTraceContext: TraceContext,
  abortSignal?: AbortSignal,
  inputId?: string,
): Promise<TurnResult> {
  const events: SessionEvent[] = [];
  const startedAt = Date.now();
  const activeTurn = this.beginActiveTurn(turnId, turnTraceContext, "rewind", false);
  // /rewind 是 executeTurnCommand 的另一条早退入口，成功终态与普通回合共用
  // 准入/提交裁决；独立的文件回退接口不经这里，不产生回合终态。
  let successTerminalAdmission: SuccessTerminalAdmission | undefined;
  let successTerminalEvent: SessionEvent | undefined;

  return runWithContextAsync(turnTraceContext, async () => {
    this.logger?.info("Rewind command started", {
      ...traceContextToLogContext(turnTraceContext),
      event: "rewind.started",
      inputLength: input.length,
      module: "core.runtime",
      status: "started",
    });

    await this.ensureSessionPersisted(input, turnTraceContext);

    const turnStartedEvent = this.createEvent(
      SessionEventType.TurnStarted,
      { turnNumber: this.turnNumber, input, inputId },
      turnTraceContext,
    );
    await this.appendEvent(turnStartedEvent, turnTraceContext);
    events.push(turnStartedEvent);

    try {
      throwIfTurnAborted(abortSignal);
      const response =
        command.action === "status"
          ? await this.formatRewindStatus()
          : command.action === "fork"
            ? (
                await this.forkWorkspaceFromCheckpoint({
                  abortSignal,
                  targetCheckpointId: command.targetCheckpointId,
                  traceContext: turnTraceContext,
                })
              ).response
            : command.action === "message"
              ? (
                  await this.rewindToMessage({
                    abortSignal,
                    events,
                    scope: command.scope,
                    targetMessageId: command.targetMessageId,
                    traceContext: turnTraceContext,
                  })
                ).response
              : command.action === "cascade-message"
                ? (
                    await this.rewindCascadeToMessage({
                      abortSignal,
                      events,
                      scope: command.scope,
                      targetMessageId: command.targetMessageId,
                      traceContext: turnTraceContext,
                    })
                  ).response
                : (
                    await this.rewindWorkspaceToCheckpoint({
                      abortSignal,
                      events,
                      targetCheckpointId: command.targetCheckpointId,
                      traceContext: turnTraceContext,
                    })
                  ).response;
      throwIfTurnAborted(abortSignal);

      const turnUsage = createModelUsageSummaryFromEvents(events);
      const completeEvent = this.createEvent(
        SessionEventType.TurnComplete,
        {
          response,
          tokenCount: 0,
          usage: turnUsage,
          toolCallCount: 0,
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
      this.logger?.info("Rewind command completed", {
        ...traceContextToLogContext(turnTraceContext),
        durationMs: Date.now() - startedAt,
        event: "rewind.completed",
        module: "core.runtime",
        status: "completed",
      });

      return {
        response,
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
        const coreError = createTurnFailureError(error, abortSignal, "Rewind failed", {
          ignoreAbortedSignal: true,
        });
        // 成功终态已提交，后续 usage/rebuild 故障不能再写 cancelled/TurnError；
        // 保留真实错误日志并向上抛出，由调用方按已完成的回退轮次处理。
        this.logger?.error("Rewind failed after success terminal commit", coreError, {
          ...traceContextToLogContext(turnTraceContext),
          event: "rewind.success_commit.post_failure",
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
        "Rewind failed",
        admitted ? { ignoreAbortedSignal: true } : undefined,
      );
      await appendTurnOutcomeEvent(this, {
        coreError,
        events,
        durationMs: Date.now() - startedAt,
        turnPhase: "rewind",
        inputId,
        traceContext: turnTraceContext,
        fallbackMessage: "Rewind failed",
        logEvent: "rewind.failed",
        logLabel: "Rewind",
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
    // 必须在 executeRewindCommand 返回前释放，后续 continuation 才能重新被 Stop。
    releaseSuccessTerminal(successTerminalAdmission);
    this.finishActiveTurn(activeTurn);
  });
}

export { formatRewindStatus } from "./rewind-status.js";

export async function rewindWorkspaceToCheckpoint(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    targetCheckpointId?: string;
    traceContext: TraceContext;
  },
): Promise<WorkspaceRewindResult> {
  const rewindId = `rewind_${crypto.randomUUID()}`;
  const sessionEvents = await this.eventStore.getEvents(this.sessionId);
  const checkpoint = selectCheckpointForRewind(sessionEvents, options.targetCheckpointId);

  if (!checkpoint) {
    return this.finishUnavailableRewind({
      events: options.events,
      reason: options.targetCheckpointId
        ? "target_checkpoint_not_found"
        : "no_checkpoint_available",
      rewindId,
      targetCheckpointId: options.targetCheckpointId,
      traceContext: options.traceContext,
    });
  }

  if (!this.artifactStore || !this.fileSystemPort) {
    return this.finishUnavailableRewind({
      checkpoint,
      events: options.events,
      reason: !this.artifactStore
        ? "artifact_store_not_configured"
        : "file_system_port_not_configured",
      rewindId,
      targetCheckpointId: checkpoint.checkpointId,
      traceContext: options.traceContext,
    });
  }

  const evaluation = evaluateRewindTarget({
    checkpointAvailable: true,
    items: buildRewindEvaluationItems(sessionEvents),
    scope: RewindScope.Workspace,
    targetMessageId: checkpoint.targetMessageId ?? checkpoint.messageId,
  });

  if (
    evaluation.strategy !== RewindStrategy.ActiveChain &&
    evaluation.strategy !== RewindStrategy.FileOnly
  ) {
    return this.finishUnavailableRewind({
      checkpoint,
      evaluation,
      events: options.events,
      reason: evaluation.reason,
      rewindId,
      targetCheckpointId: checkpoint.checkpointId,
      traceContext: options.traceContext,
    });
  }

  let artifact: WorkspaceCheckpointArtifact;
  try {
    throwIfTurnAborted(options.abortSignal);
    const read = await this.artifactStore.readToolResultArtifact(
      {
        uri: checkpoint.snapshotRef,
        trace: options.traceContext,
      },
      { signal: options.abortSignal },
    );
    artifact = parseWorkspaceCheckpointArtifact(JSON.parse(read.content));
  } catch (error) {
    if (isTurnCancellationError(error, options.abortSignal)) {
      throw createTurnCancelledError(error);
    }
    this.logger?.warn("Workspace rewind checkpoint read failed", {
      ...traceContextToLogContext(options.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "rewind.snapshot.read.failed",
      module: "core.runtime",
      snapshotRef: checkpoint.snapshotRef,
      status: "failed",
    });
    return this.finishUnavailableRewind({
      checkpoint,
      evaluation,
      events: options.events,
      reason: "checkpoint_snapshot_unavailable",
      rewindId,
      targetCheckpointId: checkpoint.checkpointId,
      traceContext: options.traceContext,
    });
  }

  const restoredFiles = await this.restoreWorkspaceCheckpointArtifact(
    artifact,
    options.traceContext,
    options.abortSignal,
  );
  const createdMessageId = createMessageId();
  const noticeBody = formatWorkspaceRewindNoticeBody({
    checkpoint,
    evaluation,
    restoredFiles,
    rewindId,
  });
  await this.persistSyntheticUserNotice(createdMessageId, noticeBody, options.traceContext);
  this.messageHistory.addAttachment("rewind_notice", noticeBody);

  const event = this.createEvent(
    SessionEventType.RewindTriggered,
    {
      rewindId,
      scope: RewindScope.Workspace,
      strategy: evaluation.strategy,
      targetMessageId: checkpoint.targetMessageId ?? checkpoint.messageId,
      targetCheckpointId: checkpoint.checkpointId,
      compactBoundaryId: evaluation.compactBoundaryId,
      restoredSnapshotRef: checkpoint.snapshotRef,
      createdMessageId,
      reason: evaluation.reason,
    },
    options.traceContext,
  );
  await this.appendEvent(event, options.traceContext);
  options.events.push(event);

  const fileText = `${restoredFiles.length} file${restoredFiles.length === 1 ? "" : "s"}`;
  const strategyText =
    evaluation.strategy === RewindStrategy.FileOnly
      ? " Workspace files were restored; conversation history stayed at the compacted context."
      : "";

  return {
    checkpoint,
    evaluation,
    restoredFiles,
    response: `Rewound workspace to checkpoint ${checkpoint.checkpointId}: restored ${fileText}.${strategyText}`,
    rewindId,
    strategy: evaluation.strategy,
  };
}

export async function finishUnavailableRewind(
  this: AgentRuntimeInternal,
  options: {
    checkpoint?: CheckpointCreatedPayload;
    evaluation?: RewindTargetEvaluation;
    events: SessionEvent[];
    reason: string;
    rewindId: string;
    scope?: RewindScope;
    targetCheckpointId?: string;
    targetMessageId?: CheckpointCreatedPayload["messageId"];
    traceContext: TraceContext;
  },
): Promise<WorkspaceRewindResult> {
  const event = this.createEvent(
    SessionEventType.RewindTriggered,
    {
      rewindId: options.rewindId,
      scope: options.scope ?? RewindScope.Workspace,
      strategy: options.evaluation?.strategy ?? RewindStrategy.Unavailable,
      targetMessageId:
        options.targetMessageId ??
        options.checkpoint?.targetMessageId ??
        options.checkpoint?.messageId,
      targetCheckpointId: options.targetCheckpointId,
      compactBoundaryId: options.evaluation?.compactBoundaryId,
      restoredSnapshotRef: undefined,
      reason: options.reason,
    },
    options.traceContext,
  );
  await this.appendEvent(event, options.traceContext);
  options.events.push(event);

  return {
    checkpoint: options.checkpoint,
    evaluation: options.evaluation,
    restoredFiles: [],
    response: formatUnavailableRewindResponse(
      options.reason,
      options.targetCheckpointId,
      options.targetMessageId,
    ),
    rewindId: options.rewindId,
    strategy: options.evaluation?.strategy ?? RewindStrategy.Unavailable,
  };
}
