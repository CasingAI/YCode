// ============================================================
// Agent Attachment - provider-visible attachment input for
// Agent dispatch and SendMessage continuation
// ============================================================

import { z } from "zod";

/**
 * 模型侧传入的子代理附件。只取图片真正需要的形状：
 * 本地 path 或内联 data URL content（二选一，至少其一），
 * 其余 filename/mimeType/sizeBytes 只做展示元信息透传。
 * `type: "url"` 故意不暴露：它只会解析为 resource_link，
 * 不是图片 part，模型传了也看不到图。
 */
export const AgentAttachmentSchema = z
  .object({
    type: z
      .enum(["image", "file", "pdf"])
      .describe("Attachment kind. Use image for screenshots and photos."),
    path: z
      .string()
      .min(1)
      .optional()
      .describe("Local file path readable by the agent runtime."),
    content: z
      .string()
      .min(1)
      .optional()
      .describe("Inline data URL (e.g. data:image/png;base64,...)."),
    filename: z.string().optional().describe("Display name for the attachment."),
    mimeType: z.string().optional().describe("MIME type hint, e.g. image/png."),
    sizeBytes: z.number().int().nonnegative().optional(),
  })
  .strict();

export type AgentAttachment = z.infer<typeof AgentAttachmentSchema>;

export const AgentAttachmentsSchema = z.array(AgentAttachmentSchema).max(8).optional();

export type AgentAttachments = z.infer<typeof AgentAttachmentsSchema>;
