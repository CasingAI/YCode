import { SessionEventType } from "../deps.js";
import type { ModelStreamingPayload, SessionEvent, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

export async function emitModelStreamingEvent(
  this: AgentRuntimeInternal,
  payload: ModelStreamingPayload,
  traceContext: TraceContext,
  events: SessionEvent[],
  timestampMs?: number,
): Promise<void> {
  const event = this.createEvent(SessionEventType.ModelStreaming, payload, traceContext);
  // 调用方（流式写队列）在入队瞬间传入帧到达时刻；默认取当下以兼容旧调用。
  // 原因见 model-streaming-event-queue：出队时刻打时间戳会把同轮 start/end 压扁成 1 秒。
  if (timestampMs !== undefined) {
    event.timestamp = new Date(timestampMs);
  }
  await this.appendEvent(event, traceContext);
  events.push(event);
}
