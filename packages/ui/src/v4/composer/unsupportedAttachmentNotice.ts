/**
 * 发送前的附件能力提示（docs/specs/model-capability-defaults.md）。
 *
 * 运行时会在请求前把模型不支持的媒体替换成占位文本
 * （apps/zcode-cli/packages/core/src/runtime/helpers/media-capability.ts），
 * 那段占位只进模型请求，用户在对话里看不到。这里在输入框下方给一行小字，
 * 让用户在发送前就知道哪些附件不会到达模型。
 *
 * 判定口径必须与运行时的媒体投影一致：能力按「缺省即不支持」处理，
 * 只有显式为 true 的能力才算支持。
 */

export type UnsupportedAttachmentKind = "image" | "pdf" | "video";

export interface ComposerAttachmentMediaInput {
  readonly mimeType: string;
}

export interface ComposerModelInputCapability {
  readonly supportsImage?: boolean;
  readonly supportsPdf?: boolean;
  readonly supportsVideo?: boolean;
}

const PDF_MIME_TYPE = "application/pdf";

/** 只有会被运行时媒体投影拦截的类型才需要提示；纯文本与其它文件不受影响。 */
function classifyAttachmentMediaKind(mimeType: string): UnsupportedAttachmentKind | undefined {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (normalized === PDF_MIME_TYPE) return "pdf";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  return undefined;
}

/**
 * 返回当前草稿里会被模型能力拦下的附件类型。
 *
 * `modelResolved` 为 false 表示模型还没解析出来（目录未加载、正在切模型），
 * 此时不提示，避免把「还不知道」说成「不支持」。
 */
export function resolveUnsupportedAttachmentKinds(params: {
  readonly attachments: readonly ComposerAttachmentMediaInput[];
  readonly modelResolved: boolean;
  readonly inputFormat?: ComposerModelInputCapability | null;
}): UnsupportedAttachmentKind[] {
  if (!params.modelResolved) return [];
  const inputFormat = params.inputFormat ?? null;
  const unsupported = new Set<UnsupportedAttachmentKind>();
  for (const attachment of params.attachments) {
    const kind = classifyAttachmentMediaKind(attachment.mimeType);
    if (!kind) continue;
    const supported =
      kind === "image"
        ? inputFormat?.supportsImage === true
        : kind === "pdf"
          ? inputFormat?.supportsPdf === true
          : inputFormat?.supportsVideo === true;
    if (!supported) unsupported.add(kind);
  }
  // 固定按图片 → PDF → 视频排序，保证同一组附件每次渲染顺序一致。
  return (["image", "pdf", "video"] as const).filter((kind) => unsupported.has(kind));
}
