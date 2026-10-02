import { TurnMachineImpl, traceContextToLogContext } from "../deps.js";
import type { MessageId, Model, ModelToolCall, ToolCallId, TraceContext } from "../deps.js";
import { emitStreamingToolLedgerUpdate } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { StreamedToolExecutionResult } from "../types.js";
import {
  createSyntheticStreamedToolResult,
  createTurnStopCancelledStreamedToolResult,
} from "./streaming-tool-synthetic-result.js";
import {
  beginStreamRecoveryAttempt,
  emitStreamRecoveryRetryEvents,
  emitStreamRecoveryStarted,
  hasStreamRecoveryBudget,
  recoverPartialAssistantOutputFailure,
} from "./streaming-recovery.js";
import { executeDuringStream } from "./streaming-tool-execution.js";
import { executeToolCallsForModelStep } from "./turn-tools.js";
import { recordModelHistoryRound, type RegularTurnLoopState } from "./turn-loop-state.js";
import { createRuntimeAssistantEntry } from "../../agent/message-history.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";

const STREAMING_TOOL_CANCEL_DRAIN_TIMEOUT_MS = 250;
const STREAMING_TOOL_EXECUTION_MODE = "readOnly";

interface StreamingToolCoordinator {
  accept(toolCall: ModelToolCall): void;
  abandon(reason: "cancelled" | "model_failed"): Promise<void>;
  drain(toolCalls: readonly ModelToolCall[]): Promise<StreamedToolExecutionResult[]>;
  recordReasoningDelta(text: string): void;
  recordTextDelta(text: string): void;
  recoverFromModelFailure(
    error: unknown,
    assistantCreatedAt: number,
    options?: { failedRequestId?: string },
  ): Promise<boolean>;
}

export function createStreamingToolCoordinator(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantMessageId: MessageId;
    model: Model;
    traceContext: TraceContext;
  },
): StreamingToolCoordinator {
  const abortController = new AbortController();
  const handles = new Map<string, Promise<StreamedToolExecutionResult | undefined>>();
  const acceptedToolCalls = new Map<string, ModelToolCall>();
  // 已起跑 = 已交给 executor；已结束 = 拿到终态结果（含失败与取消）。两者的差别决定
  // 「下一个并行组能不能起跑」：组内全部结束后才推进，组间顺序因此与流后分组执行一致。
  const startedToolCalls = new Set<string>();
  const settledToolCalls = new Set<string>();
  // 只有通过门禁的工具进入增量调度。空名与未注册工具永远不会被流中执行，
  // 让它们参与分组会占住一个永远不结束的组，把后面的工具全堵死。
  const streamingEligibleToolCalls = new Set<string>();
  const cancelledAfterTurnStop = new Map<string, StreamedToolExecutionResult>();
  let turnStopRequested = false;
  let discardedReasoningBytes = 0;
  let discardedTextBytes = 0;
  // accept 与工具结束回调都会触发起跑扫描，串行链保证两次扫描不会交叉推进分组。
  let startSweep: Promise<void> = Promise.resolve();

  const abortOnTurnCancel = () => abortController.abort();
  state.turnAbortSignal.addEventListener("abort", abortOnTurnCancel, { once: true });

  const startTool = (toolCallId: string): void => {
    if (startedToolCalls.has(toolCallId)) return;
    const toolCall = acceptedToolCalls.get(toolCallId);
    if (!toolCall) return;
    startedToolCalls.add(toolCallId);
    const execution = { batchStarted: false };
    const promise = executeDuringStream(runtime, state, {
      abortSignal: abortController.signal,
      assistantMessageId: options.assistantMessageId,
      // model admission 已去重；只有先起跑的工具会先落盘，序号必须来自全部本地声明。
      declarationIndex: declarationIndexFor(toolCallId),
      execution,
      model: options.model,
      toolCall,
      traceContext: options.traceContext,
    })
      .catch((error) => {
        // handler 已经开跑过就不能再让流后路径执行一次：合成 unknown_execution_state，
        // 由 turn-tools 的 ledgerRecorded === false 分支落终态 part。
        if (execution.batchStarted) {
          runtime.logger?.error("Streaming tool execution lost its result", error, {
            ...traceContextToLogContext(options.traceContext),
            event: "tool.streaming.result_lost",
            module: "core.runtime",
            status: "failed",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });
          return createSyntheticStreamedToolResult(toolCall);
        }
        runtime.logger?.warn("Streaming tool execution fell back to end-of-stream execution", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "tool.streaming.execution_failed",
          module: "core.runtime",
          status: "failed",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        });
        return undefined;
      })
      .then((result) => {
        // 只有真的拿到终态结果才算「已结束」。起跑失败回落到流后执行的工具没有结果，
        // 若把它标成已结束，后面并行组就会越过它起跑，副作用工具的执行顺序就乱了。
        if (result) {
          settledToolCalls.add(toolCallId);
          if (result.result.turnControl?.stopTurnAfterResult === true) {
            turnStopRequested = true;
            cancelUnstartedToolCalls();
          }
        }
        queueStartSweep();
        return result;
      });
    handles.set(toolCallId, promise);
  };

  /**
   * turn stop 的取消边界：已起跑的在途工具照常收尾，此刻还堵在分组顺序里的工具
   * 产出 ToolCancelled——与流后分组执行取消「后续组」是同一条边界。
   */
  const cancelUnstartedToolCalls = (): void => {
    for (const [toolCallId, toolCall] of acceptedToolCalls) {
      if (startedToolCalls.has(toolCallId)) continue;
      if (cancelledAfterTurnStop.has(toolCallId)) continue;
      cancelledAfterTurnStop.set(
        toolCallId,
        createTurnStopCancelledStreamedToolResult(toolCall),
      );
    }
  };

  const queueStartSweep = (): void => {
    startSweep = startSweep
      .then(async () => {
        if (turnStopRequested) return;
        // 分组语义只有 ToolScheduler 一份实现：每次按「可流中执行的已 accept 前缀」重算，
        // coordinator 只消费结果，不自己判断谁能和谁并发。
        const eligible = Array.from(acceptedToolCalls.values()).filter((toolCall) =>
          streamingEligibleToolCalls.has(toolCall.id),
        );
        const schedule = await runtime.scheduleTools(eligible);
        let earlierGroupsSettled = true;
        for (const group of schedule.parallelGroups) {
          if (earlierGroupsSettled) {
            for (const toolCallId of group) {
              if (cancelledAfterTurnStop.has(toolCallId)) continue;
              startTool(toolCallId);
            }
          }
          if (!group.every((toolCallId) => settledToolCalls.has(toolCallId))) {
            earlierGroupsSettled = false;
          }
        }
      })
      .catch((error) => {
        // 扫描本身失败（例如注册表读取异常）不吞：让调用点在 drain 阶段看到真实错误，
        // 起跑失败会退化成流后执行，不会留下半起跑状态。
        runtime.logger?.error("Streaming tool start sweep failed", error, {
          ...traceContextToLogContext(options.traceContext),
          event: "tool.streaming.start_sweep_failed",
          module: "core.runtime",
          status: "failed",
        });
      });
  };

  const declarationIndexFor = (toolCallId: string): number =>
    Array.from(acceptedToolCalls.keys()).indexOf(toolCallId);

  return {
    accept(toolCall) {
      // model.ts 已完成 runtime admission。这里必须保留空名原值，使正常 finish
      // 走 end-of-stream registry miss，同时让 finish 前断流保留 synthetic interrupted error。
      const normalizedToolCall = { ...toolCall };
      if (normalizedToolCall.providerExecuted) return;
      acceptedToolCalls.set(normalizedToolCall.id, normalizedToolCall);
      if (!isStreamingExecutionEnabled(runtime, normalizedToolCall)) return;
      streamingEligibleToolCalls.add(normalizedToolCall.id);
      if (handles.has(normalizedToolCall.id)) return;
      if (turnStopRequested) {
        // stop 之后才闭合的 tool call 不再起跑，与流后分组执行的取消边界一致。
        cancelledAfterTurnStop.set(
          normalizedToolCall.id,
          createTurnStopCancelledStreamedToolResult(normalizedToolCall),
        );
        return;
      }
      queueStartSweep();
    },

    async abandon(reason) {
      abortController.abort();
      turnStopRequested = true;
      const status = reason === "cancelled" ? "tool_cancelled" : "tool_abandoned";
      await Promise.all(
        Array.from(acceptedToolCalls.values()).map((toolCall) =>
          emitStreamingToolLedgerUpdate(runtime, state.events, options.traceContext, {
            assistantMessageId: options.assistantMessageId,
            toolCall: {
              id: toolCall.id as ToolCallId,
              input: toolCall.input,
              name: toolCall.name,
            },
            status,
            executionTiming: "during_stream",
            blockedReason: reason,
          }),
        ),
      );
      await raceWithTimeout(
        Promise.allSettled(handles.values()),
        STREAMING_TOOL_CANCEL_DRAIN_TIMEOUT_MS,
      );
      state.turnAbortSignal.removeEventListener("abort", abortOnTurnCancel);
    },

    async drain(toolCalls) {
      const results: StreamedToolExecutionResult[] = [];
      for (const toolCall of toolCalls) {
        // 每个工具收集前都先等一次扫描跑到链尾：前一个工具 await 结束时刚排进链的
        // 扫描会在此刻执行完，后一个工具的起跑因此一定已经发生。少了这一步就会在
        // 「前一个工具刚结束、后一个刚该起跑」的窗口里查不到 handle，漏掉它的结果，
        // 流后路径就会把同一个工具再执行一次。
        queueStartSweep();
        await startSweep;
        const cancelled = cancelledAfterTurnStop.get(toolCall.id);
        if (cancelled) {
          results.push(cancelled);
          continue;
        }
        const handle = handles.get(toolCall.id);
        if (!handle) continue;
        const result = await handle;
        if (result) results.push(result);
      }
      state.turnAbortSignal.removeEventListener("abort", abortOnTurnCancel);
      return results;
    },

    recordReasoningDelta(text) {
      discardedReasoningBytes += new TextEncoder().encode(text).byteLength;
    },

    recordTextDelta(text) {
      discardedTextBytes += new TextEncoder().encode(text).byteLength;
    },

    async recoverFromModelFailure(error, assistantCreatedAt, recoveryOptions = {}) {
      if (state.turnAbortSignal.aborted || !hasStreamRecoveryBudget(state)) return false;
      const recoveryEventOptions = {
        ...options,
        ...(recoveryOptions.failedRequestId
          ? { failedRequestId: recoveryOptions.failedRequestId }
          : {}),
      };
      if (acceptedToolCalls.size === 0) {
        return recoverPartialAssistantOutputFailure({
          abortController,
          assistantCreatedAt,
          discardedReasoningBytes,
          discardedTextBytes,
          error,
          options: recoveryEventOptions,
          runtime,
          state,
          turnAbortListener: abortOnTurnCancel,
        });
      }
      // 不再 abort 在途执行：已经起跑的工具（含 Bash/Edit/AskUserQuestion）必须等真实结果，
      // 合成 unknown_execution_state 再让流后路径重放会让同一个工具执行两次。
      turnStopRequested = true;
      const recoveryAttempt = beginStreamRecoveryAttempt(state);
      const toolCalls = Array.from(acceptedToolCalls.values());
      const streamedToolResults = await collectCommittedResults(handles, toolCalls);
      await emitStreamRecoveryStarted(runtime, state, recoveryEventOptions, error, recoveryAttempt);
      state.modelResponse = "";
      state.modelStepCount += 1;
      recordModelHistoryRound(state);
      state.toolCallCount += toolCalls.length;
      // 合并修复：恢复请求依赖 assistant tool-call 与随后 tool result 成对出现。
      // 因此必须同步推进本轮 request history，不能只更新 canonical history。
      commitTurnRequestEntries(runtime, state.turnRequestState, [
        createRuntimeAssistantEntry("", toolCalls, undefined, options.model),
      ]);
      state.turnMachine = new TurnMachineImpl(state.turnMachine.receiveModelResponse(""));
      // 从未起跑的工具不在 streamedToolResults 里：它们由 executeToolCallsForModelStep
      // 的 pending 路径正常执行一次，不合成失败，也不重放。
      await executeToolCallsForModelStep.call(runtime, state, {
        assistantCreatedAt,
        assistantMessageId: options.assistantMessageId,
        modelTraceContext: options.traceContext,
        result: {
          finishReason: "tool-calls",
          providerMetadata: { recoveredFromStreamFailure: true },
          text: "",
          toolCalls,
          usage: {},
        },
        streamedToolResults,
        toolCalls,
      });
      await emitStreamRecoveryRetryEvents(runtime, state, recoveryEventOptions, {
        ...recoveryAttempt,
        discardedReasoningBytes,
        discardedTextBytes,
        reason: "latest_committed_tool_result",
        toolCallIds: streamedToolResults.map((result) => result.toolCallId),
      });
      state.turnAbortSignal.removeEventListener("abort", abortOnTurnCancel);
      return true;
    },
  };
}

/**
 * 流式增量执行的门禁只剩三项总开关 + 注册表命中。
 *
 * 工具本身的属性（readOnly / concurrentSafe / needsApproval / requiresUserInteraction /
 * sideEffectScope）不再阻止流中起跑：审批与提问本来就发生在各工具开始执行时，
 * 把它们推迟到流结束只是让整批工具白等。副作用工具之间的顺序仍由 ToolScheduler 的
 * 分组语义保证（见 queueStartSweep），不是靠这道门禁。
 */
function isStreamingExecutionEnabled(
  runtime: AgentRuntimeInternal,
  toolCall: ModelToolCall,
): boolean {
  if (toolCall.providerExecuted) return false;
  if (toolCall.name.trim().length === 0) return false;
  if (runtime.config.modelStreaming !== "on") return false;
  if ((runtime.config.streamingToolExecution ?? STREAMING_TOOL_EXECUTION_MODE) === "off") {
    return false;
  }
  // 未注册工具留在流后路径：空名与幻觉名要拿 registry-miss 的成对结果。
  return runtime.registry.has(toolCall.name);
}

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * 断流恢复专用：在途工具一律等真实结果，不做超时竞速。
 *
 * 合成 unknown_execution_state 会把已经跑过的副作用工具交给流后路径再执行一次，
 * 所以这里宁可等它跑完（工具自带超时兜底），也不猜执行状态。
 */
export async function collectCommittedResults(
  handles: Map<string, Promise<StreamedToolExecutionResult | undefined>>,
  toolCalls: readonly ModelToolCall[],
): Promise<StreamedToolExecutionResult[]> {
  const settled = await Promise.all(
    toolCalls.map(async (toolCall) => {
      const handle = handles.get(toolCall.id);
      // 没起跑的工具不在这里：它由 executeToolCallsForModelStep 的 pending 路径执行一次。
      if (!handle) return undefined;
      return (await handle) ?? undefined;
    }),
  );
  return settled.filter((result): result is StreamedToolExecutionResult => result !== undefined);
}
