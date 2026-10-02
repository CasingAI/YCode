import { createPartId } from "../deps.js";
import type { MessageId, Model, ModelToolCall, ToolCall, ToolCallId, TraceContext } from "../deps.js";
import {
  emitStreamingToolLedgerUpdate,
  requireRuntimeToolCallName,
  toRecordInput,
  throwIfTurnAborted,
} from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { StreamedToolExecutionResult } from "../types.js";
import { mcpToolPartMetadata } from "./tool-part-metadata.js";
import { persistPendingToolPart } from "./tool-part-persistence.js";
import {
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
  type RegularTurnLoopState,
} from "./turn-loop-state.js";

/**
 * 单个 tool call 的流中执行：pending part → scheduled 事件 → 真正执行 → 终态结果。
 * 起跑时机的决策（谁先跑、谁必须等）在 streaming-tool-coordinator，这里只管执行。
 */
export async function executeDuringStream(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    abortSignal: AbortSignal;
    assistantMessageId: MessageId;
    declarationIndex: number;
    execution: { batchStarted: boolean };
    model: Model;
    toolCall: ModelToolCall;
    traceContext: TraceContext;
  },
): Promise<StreamedToolExecutionResult | undefined> {
  throwIfTurnAborted(state.turnAbortSignal);
  const toolName = requireRuntimeToolCallName(options.toolCall, {
    logger: runtime.logger,
    model: options.model,
    source: "streamingToolCoordinator.executeDuringStream",
    traceContext: options.traceContext,
  });
  const toolCall: ToolCall = {
    id: options.toolCall.id as ToolCallId,
    input: options.toolCall.input,
    name: toolName,
  };
  const partID = createPartId();
  const input = toRecordInput(toolCall.input);
  const metadata = mcpToolPartMetadata(
    runtime.registry.getMetadata(toolCall.name)?.mcpPresentation,
  );
  // during_stream 是 pending/running part 的首个 durable writer；若绕过
  // turn-tools 的 metadata 写入，Stop 发生在 drain 前时冷恢复只能退化成通用工具卡。
  await persistPendingToolPart(runtime, {
    assistantMessageId: options.assistantMessageId,
    declarationIndex: options.declarationIndex,
    input,
    metadata,
    model: options.model,
    partID,
    toolCall,
    traceContext: options.traceContext,
  });
  await emitStreamingToolLedgerUpdate(runtime, state.events, options.traceContext, {
    assistantMessageId: options.assistantMessageId,
    toolCall,
    status: "tool_call_closed",
    executionTiming: "during_stream",
    input,
  });

  const schedule = await runtime.scheduleTools([toolCall]);
  const scheduledEvents = await runtime.emitToolScheduledEvents(
    [toolCall],
    schedule,
    options.assistantMessageId,
    options.traceContext,
  );
  state.events.push(...scheduledEvents);
  await emitStreamingToolLedgerUpdate(runtime, state.events, options.traceContext, {
    assistantMessageId: options.assistantMessageId,
    toolCall,
    status: "tool_queued",
    executionTiming: "during_stream",
    input,
  });

  const execution = await runtime.executeTools([toolCall], schedule, {
    subagentModelOverride: state.subagentModelOverride,
    model: state.model,
    automationTurn: isAutomationMutationRestrictedTurn(state),
    offPeakTurn: isOffPeakCreateRestrictedTurn(state),
    signal: options.abortSignal,
    traceContext: options.traceContext,
    onBatchStart: async () => {
      // 只有走到这里才允许把执行失败当作「没跑过」：handler 由 batch-runner 在
      // batch_start 之后发起，onBatchStart 之前抛错时工具确实还没执行，流后重放安全。
      options.execution.batchStarted = true;
      const startedAt = Date.now();
      await runtime.persistPart(
        {
          id: partID,
          sessionID: runtime.sessionId,
          messageID: options.assistantMessageId,
          type: "tool",
          callID: toolCall.id,
          declarationIndex: options.declarationIndex,
          tool: toolCall.name,
          state: {
            status: "running",
            input,
            title: toolCall.name,
            metadata: metadata ?? {},
            time: {
              start: startedAt,
            },
          },
        },
        options.traceContext,
      );
      await emitStreamingToolLedgerUpdate(runtime, state.events, options.traceContext, {
        assistantMessageId: options.assistantMessageId,
        toolCall,
        status: "tool_started",
        executionTiming: "during_stream",
        input,
        startedAt: new Date(startedAt),
      });
    },
  });
  state.events.push(...execution.events);
  const result = execution.results[0];
  if (!result) return undefined;
  return {
    input,
    ledgerRecorded: true,
    partID,
    result,
    toolCallId: toolCall.id as ToolCallId,
  };
}
