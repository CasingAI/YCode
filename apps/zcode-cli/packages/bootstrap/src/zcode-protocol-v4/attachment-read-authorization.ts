// 附件读取授权的事实来源（docs/specs/conversation-queue-edit-attachment-preview.md）。
//
// attachmentRead 的授权判据是「当前 session 的权威事实证明这个 ref 属于本 session」。
// 已发送消息有 user row 证明；队列项同样能证明——队列项是 session 自己的投影，
// 其中的 AttachmentRef 就是本 session 收下过的引用。
import { isPreviewableAttachmentMime } from "@zcode/shared/zcode-protocol-v4";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";

interface QueueItemAttachmentSource {
  attachments?: readonly AttachmentRef[] | undefined;
}

/**
 * 在 session 的队列项里找出与 ref 对应的可预览附件。
 *
 * 判据是「权威队列项里存在同 ref 的附件」，renderer 自报的任意路径不会因此放行；
 * 与 user row 一致，存在 previewRef 时只认 previewRef 这个 durable 引用。
 */
export function findAuthorizedQueueAttachment(params: {
  queueItems: readonly QueueItemAttachmentSource[];
  ref: string;
}): AttachmentRef | null {
  for (const queueItem of params.queueItems) {
    for (const attachment of queueItem.attachments ?? []) {
      if (!isPreviewableAttachmentMime(attachment.mime)) continue;
      if ((attachment.previewRef ?? attachment.ref) === params.ref) return attachment;
    }
  }
  return null;
}
