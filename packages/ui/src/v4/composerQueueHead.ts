import type { QueueItem, QueueState } from "@zcode/shared/zcode-protocol-v4";
import { projectPendingGuideQueue } from "@/v4/pendingGuideProjection.js";

/**
 * 空草稿按 Enter 要立即发送的那一项。
 *
 * 必须与队列面板渲染的是同一份列表：面板拿的是 projectPendingGuideQueue 之后的
 * visibleQueue（等待 model-step 注入的 guide 项被藏起来），直接取 queue.items[0]
 * 会出现「提示文案说的是 A、实际发出去的是 B」。dispatch.state 非 queued 的项
 * （reserved / promoting）同样不可再次触发，面板已按它禁用「立即」按钮。
 */
export function resolveComposerQueueHead(queue: QueueState): QueueItem | null {
  return (
    projectPendingGuideQueue(queue).visibleQueue.items.find(
      (item) => item.dispatch.state === "queued",
    ) ?? null
  );
}
