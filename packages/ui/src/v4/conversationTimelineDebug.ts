import { logger } from "@/logger.js";

const DEBUG_EVENT_PREFIX = "[v4-timeline-scroll-debug]";
const FLUSH_DELAY_MS = 50;
const MAX_BATCH_EVENTS = 128;

let sequence = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingEvents: Record<string, unknown>[] = [];

function flush(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingEvents.length === 0) return;

  const events = pendingEvents;
  pendingEvents = [];
  try {
    logger.lifecycle.info(DEBUG_EVENT_PREFIX, { events });
  } catch {
    // 诊断桥接异常只丢当前批次，不能影响时间线滚动。
  }
}

/** 临时滚动诊断出口；只写结构化元数据，不改变时间线状态。 */
export function recordConversationTimelineDebugEvent(
  probeId: string,
  data: Record<string, unknown>,
): void {
  sequence += 1;
  pendingEvents.push({ probeId, sequence, ...data });
  if (pendingEvents.length >= MAX_BATCH_EVENTS) {
    flush();
    return;
  }
  flushTimer ??= setTimeout(flush, FLUSH_DELAY_MS);
}
