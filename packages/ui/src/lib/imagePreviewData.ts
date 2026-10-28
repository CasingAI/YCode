import type { IFileService } from "@zcode/services";
import { decodeBase64ToArrayBuffer } from "./officeFilePreview.js";

/** 图片原始文件上限；边界值允许，超过后不再发起任何 range 请求。 */
export const IMAGE_PREVIEW_MAX_BYTES = 64 * 1024 * 1024;

/** 与文件服务 readFileRange 的硬上限一致，保证每次 RPC 只读一个顶层 Uint8Array。 */
const IMAGE_PREVIEW_CHUNK_BYTES = 1024 * 1024;

export type ImagePreviewErrorCode =
  | "too-large"
  | "not-file"
  | "invalid-size"
  | "empty-chunk"
  | "short-read"
  | "oversized-read"
  | "size-changed";

/**
 * 图片读取的本地可判定错误。
 *
 * 错误信息不含路径，也不承担用户展示文案；调用方按 code 决定提示。
 * stat / readFileRange 自身的原始错误（例如 ENOENT）不包装，继续交给
 * 现有 isMissingFileError 判断。
 */
export class ImagePreviewError extends Error {
  readonly code: ImagePreviewErrorCode;

  constructor(code: ImagePreviewErrorCode) {
    super(`Image preview failed: ${code}`);
    this.name = "ImagePreviewError";
    this.code = code;
  }
}

/** 只依赖文件读取能力，避免 UI helper 绑定完整服务实现。 */
export type ImagePreviewFileService = Pick<
  IFileService,
  "stat" | "readFileRange" | "readMediaPreview"
>;

export interface ReadImagePreviewBlobParams {
  fileService: ImagePreviewFileService;
  path: string;
  mediaType: string;
  signal?: AbortSignal;
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function isValidSize(size: unknown): size is number {
  return typeof size === "number" && Number.isSafeInteger(size) && size >= 0;
}

async function readLegacyImagePreviewBlob(
  params: ReadImagePreviewBlobParams,
): Promise<Blob | null> {
  if (isAborted(params.signal)) {
    return null;
  }
  // 仅当旧服务没有 size 时进入这里；保留 readMediaPreview 原有上限与错误语义。
  const preview = await params.fileService.readMediaPreview({ path: params.path });
  if (isAborted(params.signal)) {
    return null;
  }
  const bytes = new Uint8Array(decodeBase64ToArrayBuffer(preview.dataBase64));
  return new Blob([bytes], { type: params.mediaType || preview.mediaType });
}

/**
 * 按 stat 大小串行分块读取图片并组装 Blob。
 *
 * - 每个请求最多 1 MiB，返回值必须是顶层 Uint8Array；
 * - 短读、空块、超读、结束尺寸变化都拒绝，避免渲染半张图；
 * - AbortSignal 中止后不再发起下一块，迟到块直接丢弃（返回 null）；
 * - 无 size 的旧服务只回退 readMediaPreview，不做读取失败后的二次兜底。
 */
export async function readImagePreviewBlob(
  params: ReadImagePreviewBlobParams,
): Promise<Blob | null> {
  if (isAborted(params.signal)) {
    return null;
  }

  const initialStat = await params.fileService.stat({ path: params.path });
  if (isAborted(params.signal)) {
    return null;
  }
  if (initialStat.type !== "file") {
    throw new ImagePreviewError("not-file");
  }
  if (initialStat.size === undefined) {
    return readLegacyImagePreviewBlob(params);
  }
  if (!isValidSize(initialStat.size)) {
    // size 存在但不可信时不能猜成 0 或改走 base64，否则会掩盖 Host 契约错误。
    throw new ImagePreviewError("invalid-size");
  }

  const totalBytes = initialStat.size;
  if (totalBytes > IMAGE_PREVIEW_MAX_BYTES) {
    // 超限判断必须早于任何 range，避免先读一部分再失败。
    throw new ImagePreviewError("too-large");
  }

  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  while (offset < totalBytes) {
    if (isAborted(params.signal)) {
      return null;
    }
    const requestedLength = Math.min(IMAGE_PREVIEW_CHUNK_BYTES, totalBytes - offset);
    const chunk = await params.fileService.readFileRange({
      path: params.path,
      offset,
      length: requestedLength,
    });
    // RPC 可能在取消后才返回；此时不再校验、不追加块，也不创建 Blob。
    if (isAborted(params.signal)) {
      return null;
    }
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
      throw new ImagePreviewError("empty-chunk");
    }
    if (chunk.byteLength > requestedLength) {
      throw new ImagePreviewError("oversized-read");
    }
    if (chunk.byteLength < requestedLength) {
      throw new ImagePreviewError("short-read");
    }
    // 按视图范围复制到独立 ArrayBuffer，避免服务复用缓冲覆盖旧块及 SharedArrayBuffer 不兼容 Blob。
    chunks.push(new Uint8Array(chunk));
    offset += chunk.byteLength;
  }

  if (isAborted(params.signal)) {
    return null;
  }
  // 结束后再 stat：路径变为目录、文件被截断或删除时不提交已拼接的字节。
  const finalStat = await params.fileService.stat({ path: params.path });
  if (isAborted(params.signal)) {
    return null;
  }
  if (finalStat.type !== "file" || !isValidSize(finalStat.size) || finalStat.size !== totalBytes) {
    throw new ImagePreviewError("size-changed");
  }

  return new Blob(chunks, { type: params.mediaType });
}
