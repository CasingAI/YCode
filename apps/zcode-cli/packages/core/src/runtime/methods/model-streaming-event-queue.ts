import type { ModelStreamingPayload, SessionEvent, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

const MODEL_STREAMING_EVENT_WRITE_HIGH_WATER_MARK = 128;

interface ModelStreamingEventQueue {
  drain(): Promise<void>;
  enqueue(payload: ModelStreamingPayload): void;
  maybeApplyBackpressure(): Promise<void>;
}

export function createModelStreamingEventQueue(params: {
  clock?: () => number;
  events: SessionEvent[];
  highWaterMark?: number;
  runtime: AgentRuntimeInternal;
  traceContext: TraceContext;
}): ModelStreamingEventQueue {
  const clock = params.clock ?? Date.now;
  const highWaterMark = params.highWaterMark ?? MODEL_STREAMING_EVENT_WRITE_HIGH_WATER_MARK;
  let pendingWrites = 0;
  let tail: Promise<void> = Promise.resolve();
  let writeFailure: unknown;

  const assertNoWriteFailure = (): void => {
    if (writeFailure) {
      throw writeFailure;
    }
  };

  const drain = async (): Promise<void> => {
    await tail;
    assertNoWriteFailure();
  };

  return {
    async drain(): Promise<void> {
      await drain();
    },

    enqueue(payload: ModelStreamingPayload): void {
      assertNoWriteFailure();
      pendingWrites += 1;
      // 事件时间戳必须在入队（帧到达）时刻确定：append 是串行写队列，
      // 落库/通知耗时会让出队时刻整体后移。若在出队时才打时间戳，
      // 同一轮的 reasoning_start/end 会被挤到相邻毫秒，投影算出的
      // durationMs 恒为 0/1 秒。startedAt 由调用方时钟在入队瞬间读取。
      const enqueuedAt = clock();
      tail = tail
        .then(async () => {
          if (writeFailure) {
            return;
          }
          await params.runtime.emitModelStreamingEvent(
            payload,
            params.traceContext,
            params.events,
            enqueuedAt,
          );
        })
        .catch((error: unknown) => {
          writeFailure ??= error;
        })
        .finally(() => {
          pendingWrites -= 1;
        });
    },

    async maybeApplyBackpressure(): Promise<void> {
      assertNoWriteFailure();
      if (pendingWrites < highWaterMark) {
        return;
      }
      await drain();
    },
  };
}
