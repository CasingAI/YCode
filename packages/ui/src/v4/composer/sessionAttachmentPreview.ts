// 队列项撤回编辑的附件预览（docs/specs/conversation-queue-edit-attachment-preview.md）。
//
// AttachmentRef 只是元信息，撤回编辑时按它重建的附件 chip 没有图片字节，渲染会退化成
// 通用文件图标。预览一律经 transport 的 attachmentRead 读回：附件字节归 CLI 所有，
// UI 不缓存字节、也不自己解析 ref。
//
// 读取时机由调用方保证：队列项被删除后 CLI 不再持有这些引用，读取授权随即失效，
// 因此必须在删除队列项之前读回。
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import { isPreviewableAttachmentMime } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationAttachmentReadParams } from "@/v4/transport.js";
import { logger } from "@/logger.js";

export { isPreviewableAttachmentMime };

/** 与 transport.attachmentRead 同形：本地媒体可返回已授权 URL，其余返回字节。 */
export type SessionAttachmentReadFn = (
  params: ConversationAttachmentReadParams,
) => Promise<{ bytes: Uint8Array; mediaType: string } | { url: string; mediaType: string }>;

/**
 * 读回一个附件的预览 URL。
 * 返回 null 表示这份附件没有可预览内容（不是媒体），调用方保持通用文件图标。
 */
export async function readSessionAttachmentPreviewUrl(params: {
  attachmentRef: AttachmentRef;
  readAttachment: SessionAttachmentReadFn;
  sessionId: string;
}): Promise<string | null> {
  const ref = params.attachmentRef.previewRef ?? params.attachmentRef.ref;
  const result = await params.readAttachment({
    sessionId: params.sessionId,
    ref,
    mediaType: params.attachmentRef.mime,
  });
  if ("url" in result) return result.url;
  return URL.createObjectURL(new Blob([Uint8Array.from(result.bytes)], { type: result.mediaType }));
}

/**
 * 为一组附件读回预览 URL，按 ref 索引。
 *
 * 读不回不影响撤回编辑本身：失败的附件退回通用文件图标，其余照常恢复。
 */
export async function prepareSessionAttachmentPreviews(params: {
  attachments: readonly AttachmentRef[];
  readAttachment: SessionAttachmentReadFn;
  sessionId: string;
}): Promise<Map<string, string>> {
  const previews = new Map<string, string>();
  const results = await Promise.all(
    params.attachments.map(async (attachment) => {
      if (!isPreviewableAttachmentMime(attachment.mime)) return null;
      try {
        const url = await readSessionAttachmentPreviewUrl({
          attachmentRef: attachment,
          readAttachment: params.readAttachment,
          sessionId: params.sessionId,
        });
        return url ? ([attachment.ref, url] as const) : null;
      } catch (error) {
        logger.warn("[v4-composer-attachments] 队列附件预览读取失败", error);
        return null;
      }
    }),
  );
  for (const entry of results) {
    if (entry) previews.set(entry[0], entry[1]);
  }
  return previews;
}

/** 回收预览 URL。URL 不是 blob（桌面本地媒体协议 URL）时撤销是空操作。 */
export function revokeSessionAttachmentPreviews(previews: ReadonlyMap<string, string>): void {
  for (const url of previews.values()) {
    URL.revokeObjectURL(url);
  }
}

export interface RestoredSessionAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** 预览 URL；缺失时 chip 渲染会退化成通用文件图标。 */
  objectUrl?: string;
  attachmentRef: AttachmentRef;
}

/**
 * 撤回编辑时按 AttachmentRef 重建附件 chip 的字段。
 * 预览 URL 按 ref 取用（队列项的 ref 与当初发送时一致）。
 */
export function buildRestoredSessionAttachments(params: {
  attachmentRefs: readonly AttachmentRef[];
  previews?: ReadonlyMap<string, string>;
  createId: () => string;
}): RestoredSessionAttachment[] {
  return params.attachmentRefs.map((attachmentRef) => {
    const previewUrl = params.previews?.get(attachmentRef.ref);
    return {
      id: params.createId(),
      filename: attachmentRef.fileName,
      mimeType: attachmentRef.mime,
      sizeBytes: attachmentRef.bytes,
      ...(previewUrl ? { objectUrl: previewUrl } : {}),
      attachmentRef: { ...attachmentRef },
    };
  });
}
