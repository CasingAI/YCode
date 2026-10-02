import { CoreErrorType, SessionEventType, createPartId } from "../deps.js";
import type {
  ModelToolCall,
  SessionEvent,
  ToolCallId,
  ToolExecutionResult,
  TraceContext,
} from "../deps.js";
import { toRecordInput } from "../helpers/index.js";
import { TOOL_CANCELLED_AFTER_TURN_STOP } from "../../tool/executor/turn-stop-messages.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { StreamedToolExecutionResult } from "../types.js";

const STREAM_RECOVERY_TOOL_ERROR_TYPE = "stream_recovery_interrupted_tool";

const TOOL_STATE_UNKNOWN_MESSAGE =
  "Tool execution was interrupted during streaming recovery before a result was committed. Side effects may be unknown; inspect current state before retrying.";

export function createSyntheticStreamedToolResult(
  toolCall: ModelToolCall,
): StreamedToolExecutionResult {
  const now = new Date();
  const result: ToolExecutionResult = {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    success: false,
    output: null,
    modelContent: TOOL_STATE_UNKNOWN_MESSAGE,
    error: {
      type: STREAM_RECOVERY_TOOL_ERROR_TYPE,
      message: TOOL_STATE_UNKNOWN_MESSAGE,
    },
    durationMs: 0,
    startedAt: now,
    completedAt: now,
  };

  return {
    input: toRecordInput(toolCall.input),
    ledgerRecorded: false,
    partID: createPartId(),
    result,
    toolCallId: toolCall.id as ToolCallId,
  };
}

/**
 * turn stop 生效之后才到达（因而还没起跑）的工具调用。取消边界与流后分组执行完全一致：
 * stop 结果之前已起跑的工具照常收尾，之后的由这里产出 ToolCancelled，复用同一句文案。
 */
export function createTurnStopCancelledStreamedToolResult(
  toolCall: ModelToolCall,
): StreamedToolExecutionResult {
  const now = new Date();
  const result: ToolExecutionResult = {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    success: false,
    output: null,
    modelContent: TOOL_CANCELLED_AFTER_TURN_STOP,
    error: {
      type: CoreErrorType.ToolCancelled,
      message: TOOL_CANCELLED_AFTER_TURN_STOP,
    },
    durationMs: 0,
    startedAt: now,
    completedAt: now,
  };

  return {
    input: toRecordInput(toolCall.input),
    ledgerRecorded: false,
    partID: createPartId(),
    result,
    toolCallId: toolCall.id as ToolCallId,
  };
}

export async function emitSyntheticStreamedToolError(
  runtime: AgentRuntimeInternal,
  events: SessionEvent[],
  traceContext: TraceContext,
  result: ToolExecutionResult,
): Promise<void> {
  if (!result.error) return;
  const event = runtime.createEvent(
    SessionEventType.ToolCallError,
    {
      toolCallId: result.toolCallId as ToolCallId,
      error: result.error,
    },
    traceContext,
  );
  await runtime.appendEvent(event, traceContext);
  events.push(event);
}
