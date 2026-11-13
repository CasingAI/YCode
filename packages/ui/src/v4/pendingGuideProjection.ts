import type { QueueItem, QueueState } from "@zcode/shared/zcode-protocol-v4";

export interface PendingGuideQueueProjection {
  pendingGuides: readonly QueueItem[];
  visibleQueue: QueueState;
}

/** 空 pendingGuides 的稳定引用：下游 memo 以引用判断，不能每次投影都新建 []。 */
export const EMPTY_PENDING_GUIDES: readonly QueueItem[] = Object.freeze([]);

/**
 * CLI 用同一份 queue fact 可靠承载 guide 与 future queue；旧 UI 直接渲染
 * queue.items，导致等待 model-step 注入的 guide 被误画成下一轮消息。这里只按权威
 * admitted delivery 分流展示，不复制、不改写 accepted input 状态。
 */
export function projectPendingGuideQueue(queue: QueueState): PendingGuideQueueProjection {
  const pendingGuides: QueueItem[] = [];
  const visibleItems: QueueItem[] = [];
  for (const item of queue.items) {
    if (item.delivery.admitted === "guide") {
      pendingGuides.push(item);
    } else {
      visibleItems.push(item);
    }
  }
  if (pendingGuides.length === 0) {
    return { pendingGuides: EMPTY_PENDING_GUIDES, visibleQueue: queue };
  }
  return {
    pendingGuides,
    visibleQueue:
      visibleItems.length === queue.items.length ? queue : { ...queue, items: visibleItems },
  };
}
