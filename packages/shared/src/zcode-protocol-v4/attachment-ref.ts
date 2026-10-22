import { z } from "zod";

/** 仅承载已提交内容引用与展示元信息；内容本体不进入 command/topic frame。 */
export const attachmentRefSchema = z
  .object({
    ref: z.string(),
    fileName: z.string(),
    mime: z.string(),
    bytes: z.number(),
    previewRef: z.string().optional(),
  })
  .strict();

export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

/**
 * 可预览附件的 MIME 判据：image / video / PDF。
 *
 * CLI 的 attachmentRead 授权与 UI 的预览渲染必须用同一条判据，否则会出现
 * 「UI 认为可预览、CLI 拒绝授权」的错位（附件退化成通用文件图标）。
 */
export function isPreviewableAttachmentMime(mime: string): boolean {
  const normalized = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    normalized.startsWith("image/") ||
    normalized.startsWith("video/") ||
    normalized === "application/pdf"
  );
}
