import type { ModelStreamEvent } from "@zcode/contracts";

// Note: these events are buffered, not yielded, until a committed stream boundary appears.
// If a network reset happens first, the partial tool-input attempt can be discarded.
// 非空 reasoning_delta 是用户感知的首个输出 token，不能等待正文或工具边界才释放。
const RETRY_SAFE_PRELUDE_STREAM_EVENT_TYPES = new Set<ModelStreamEvent["type"]>([
  "start",
  "text_start",
  "text_end",
  "reasoning_start",
  "reasoning_end",
  "tool_input_start",
  "tool_input_delta",
  "tool_input_end",
]);

export function isRetrySafePreludeStreamEvent(event: ModelStreamEvent): boolean {
  // SDK 把纯签名转成空 reasoning_delta；将其视为已输出会停止 adapter retry，
  // 而 core 无文本、无完整工具调用时也无法恢复。空 delta 随前奏暂存，成功时保留签名原序释放。
  if (event.type === "reasoning_delta" || event.type === "text_delta") {
    return event.text.length === 0;
  }
  return RETRY_SAFE_PRELUDE_STREAM_EVENT_TYPES.has(event.type);
}

export interface StreamRetryBoundaryResult {
  emittedError: false;
  emittedEvent: boolean;
  emittedRetryBoundaryEvent: boolean;
  offPeakQueueHold: false;
  retryScheduled: false;
  terminalError?: undefined;
  visibleEvents: ModelStreamEvent[];
}

/**
 * Route retry-safe prelude events without treating them as a committed provider response.
 * Responses phase lifecycle is shown immediately while the request remains retryable.
 */
export function applyStreamEventsToRetryBoundary(input: {
  emittedRetryBoundaryEvent: boolean;
  events: ModelStreamEvent[];
  pendingRetrySafeEvents: ModelStreamEvent[];
  providerEventObserved?: boolean;
  preserveProviderStreamBoundaries?: boolean;
}): StreamRetryBoundaryResult {
  let emittedEvent = false;
  let emittedRetryBoundaryEvent = input.emittedRetryBoundaryEvent;
  const visibleEvents: ModelStreamEvent[] = [];

  if (input.providerEventObserved && !emittedRetryBoundaryEvent) {
    visibleEvents.push(...input.pendingRetrySafeEvents.splice(0));
    emittedRetryBoundaryEvent = true;
  }

  for (const event of input.events) {
    emittedEvent = true;
    if (event.type === "reasoning_phase_start" || event.type === "reasoning_phase_end") {
      // Bug 原因：把阶段事件也当 retry-safe 前奏缓存，隐藏 CoT 无内容时会一直等到正文才显示。
      // 修复依据：阶段仅是观测状态，不提交 provider 输出；即时显示仍允许失败后重试。
      visibleEvents.push(event);
      continue;
    }

    // AI SDK 的 start 在读取 provider stream 前本地合成，不能冒充首个 provider event；
    // compact 一旦收到其余真实事件就停止 SSE retry，再由 Core 的 block commit 决定能否 HTTP fallback。
    const retrySafePrelude =
      isRetrySafePreludeStreamEvent(event) &&
      (!input.preserveProviderStreamBoundaries || event.type === "start");
    if (retrySafePrelude && !emittedRetryBoundaryEvent) {
      input.pendingRetrySafeEvents.push(event);
      continue;
    }

    if (!emittedRetryBoundaryEvent) {
      visibleEvents.push(...input.pendingRetrySafeEvents.splice(0));
    }
    visibleEvents.push(event);
    emittedRetryBoundaryEvent = true;
  }

  return {
    emittedError: false,
    emittedEvent,
    emittedRetryBoundaryEvent,
    offPeakQueueHold: false,
    retryScheduled: false,
    visibleEvents,
  };
}
