import { FILE_TEXT_WINDOW_MAX_BYTES, type FileTextWindow } from "@zcode/shared";

/**
 * 固定块大文件模型的纯函数核心。
 *
 * 块坐标始终基于原文件的字节偏移：`blockIndex = floor(offset / STEP)`。
 * 名义边界落在合法 UTF-8 多字节码点内部时向前对齐到该码点之后（最多 +3 字节）；
 * 非法字节保持请求偏移。块之间连续、不重叠、无空洞。
 *
 * 本模块不读盘、不持有状态：UI / range store 只调用这里的数学，避免各处
 * 重复实现边界算法。
 */

/** `256 KiB - 4`：给名义边界对齐与窗口尾部回退留出 4 字节余量。 */
export const FILES_LARGE_TEXT_BLOCK_STEP = FILE_TEXT_WINDOW_MAX_BYTES - 4;

const UTF8_MAX_BYTES = 4;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

function normalizeIndex(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function normalizeBytes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export function filesLargeTextBlockIndex(offset: number): number {
  return Math.floor(normalizeBytes(offset) / FILES_LARGE_TEXT_BLOCK_STEP);
}

export function filesLargeTextNominalBlockStart(blockIndex: number): number {
  return normalizeIndex(blockIndex) * FILES_LARGE_TEXT_BLOCK_STEP;
}

export function filesLargeTextNominalBlockEnd(blockIndex: number): number {
  return (normalizeIndex(blockIndex) + 1) * FILES_LARGE_TEXT_BLOCK_STEP;
}

/** 空文件也保留唯一的零长度块（block 0）。 */
export function filesLargeTextBlockCount(totalBytes: number): number {
  const total = normalizeBytes(totalBytes);
  return Math.max(1, Math.ceil(total / FILES_LARGE_TEXT_BLOCK_STEP));
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function utf8SequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/**
 * 把边界向前对齐到下一个 UTF-8 码点起点。
 *
 * 只有 `position` 确实位于一个**合法** 2–4 字节码点内部时才前进到该码点之后；
 * ASCII 边界、非法 continuation、截断序列都保持 `position`，对应规范里的
 * 「非法保持 requestedOffset」。
 */
export function resolveFilesLargeTextAlignedBoundary(bytes: Uint8Array, position: number): number {
  if (!Number.isFinite(position)) return 0;
  const target = Math.max(0, Math.min(Math.floor(position), bytes.length));
  if (target <= 0 || target >= bytes.length) return target;
  const byte = bytes[target];
  if (byte === undefined || !isUtf8Continuation(byte)) return target;

  for (let lead = target - 1; lead >= Math.max(0, target - (UTF8_MAX_BYTES - 1)); lead -= 1) {
    const leadByte = bytes[lead];
    if (leadByte === undefined || isUtf8Continuation(leadByte)) continue;
    const length = utf8SequenceLength(leadByte);
    // 最近的非 continuation 字节要么是合法码点首字节，要么说明这里就是非法序列。
    if (length < 2 || lead + length <= target) return target;
    if (lead + length > bytes.length) return target;
    for (let index = 1; index < length; index += 1) {
      const continuation = bytes[lead + index];
      if (continuation === undefined || !isUtf8Continuation(continuation)) return target;
    }
    return lead + length;
  }
  return target;
}

/** 首码点在原始 UTF-8 中占用的字节数；调用方仅在服务向前回退到合法码点时使用。 */
export function filesLargeTextCodePointByteLengthAtStart(content: string): number {
  const codePoint = content.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return UTF8_MAX_BYTES;
}

function dropFirstCodePoint(content: string): string {
  const codePoint = content.codePointAt(0);
  if (codePoint === undefined) return content;
  return content.slice(codePoint > 0xffff ? 2 : 1);
}

/** 仅用于非法块的只读展示：按重新编码后的近似字节边界裁剪，不产生补丁。 */
function sliceDecodedContentApprox(content: string, byteLimit: number): string {
  if (byteLimit <= 0) return "";
  const bytes = encoder.encode(content);
  return decoder.decode(bytes.subarray(0, Math.min(byteLimit, bytes.length)));
}

export interface FilesLargeTextBlockSlice {
  blockIndex: number;
  /** 块在原文件字节坐标中的实际起点（已向前对齐到合法码点起始）。 */
  offset: number;
  /** 块的实际结束位置；下一块优先用它作为请求 offset。 */
  nextOffset: number;
  content: string;
  /** 只描述本块精确字节范围；合法编码的 U+FFFD 不会置位。 */
  hasDecodingErrors: boolean;
  /**
   * 初次窗口无法确定本块真实结束位置时需要精确复核：
   * - 含非法字节时，无法区分错误属于本块还是越界尾部；
   * - 合法但窗口被服务尾部回退截短时，未覆盖到名义结束位置。
   * 调用方应先对 nominalEnd 做最小边界 probe，再按精确范围重读。
   */
  needsExactConfirmation: boolean;
}

export interface FilesLargeTextBlockReadRequest {
  offset: number;
  length: number;
  expectedVersion?: string;
}

/**
 * 单块读取请求。未提供 `startOffset` 时按用户固定设计从名义边界读取 256 KiB；
 * 相邻块已确定 `actualStart` 时优先复用，避免服务再次向前回退。
 */
export function filesLargeTextBlockReadRequest(params: {
  blockIndex: number;
  totalBytes: number;
  startOffset?: number;
  expectedVersion?: string;
}): FilesLargeTextBlockReadRequest {
  const totalBytes = normalizeBytes(params.totalBytes);
  const offset =
    params.startOffset === undefined
      ? filesLargeTextNominalBlockStart(params.blockIndex)
      : Math.max(0, Math.min(normalizeBytes(params.startOffset), totalBytes));
  const length = Math.max(4, Math.min(FILE_TEXT_WINDOW_MAX_BYTES, totalBytes - offset));
  return {
    offset,
    length,
    ...(params.expectedVersion === undefined
      ? undefined
      : { expectedVersion: params.expectedVersion }),
  };
}

/**
 * 初次窗口报告非法字节后，用本块精确范围复核。
 *
 * 初次窗口为了 UTF-8 边界会多读最多 4 字节；这里的范围严格是本块
 * `[offset, nextOffset)`，因此返回的 `hasDecodingErrors` 只属于本块。
 */
export function filesLargeTextExactBlockReadRequest(params: {
  slice: Pick<FilesLargeTextBlockSlice, "offset" | "nextOffset">;
  totalBytes: number;
  expectedVersion?: string;
}): FilesLargeTextBlockReadRequest {
  const totalBytes = normalizeBytes(params.totalBytes);
  const offset = Math.max(0, Math.min(normalizeBytes(params.slice.offset), totalBytes));
  const desiredEnd = Math.min(totalBytes, normalizeBytes(params.slice.nextOffset));
  const length = Math.max(4, Math.min(FILE_TEXT_WINDOW_MAX_BYTES, desiredEnd - offset));
  return {
    offset,
    length,
    ...(params.expectedVersion === undefined
      ? undefined
      : { expectedVersion: params.expectedVersion }),
  };
}

/**
 * 把一次窗口读取裁剪为固定块。
 *
 * 初次读取从 `nominalStart` 开始，服务可能向前回退到合法码点起始；这里先丢掉
 * 回退出来的首码点，再把尾部裁到下一个名义边界（合法码点内部则向前对齐）。
 * 非法窗口或未覆盖名义边界的短窗口会要求请求层 probe，并把真实结束位置通过
 * `knownEnd` 传回；相邻块应复用上一块的 `nextOffset`。
 */
export function sliceFilesLargeTextBlockWindow(params: {
  blockIndex: number;
  totalBytes: number;
  window: FileTextWindow;
  knownStart?: number;
  /**
   * 边界 probe 得到的真实结束位置。名义边界落在合法多字节码点内部时必须由
   * 请求层先探查再传入；非法正文不能靠解码内容的重新编码长度反推原字节坐标。
   */
  knownEnd?: number;
  exact?: boolean;
  /**
   * 请求层主动加载时启用：合法但未覆盖 nominalEnd 的截短窗口需要 probe 真实结束
   * 位置。seed 的首窗固定从 offset 0 开始，不受起点回退影响，保持默认关闭。
   */
  probeShortWindow?: boolean;
}): FilesLargeTextBlockSlice {
  const blockIndex = normalizeIndex(params.blockIndex);
  const totalBytes = normalizeBytes(params.totalBytes);
  const nominalStart = filesLargeTextNominalBlockStart(blockIndex);
  const nominalEnd = filesLargeTextNominalBlockEnd(blockIndex);
  const requestedStart =
    params.knownStart === undefined ? nominalStart : normalizeBytes(params.knownStart);

  let offset = requestedStart;
  let content = params.window.content;
  const servedOffset = normalizeBytes(params.window.offset);
  const leadingBytes = requestedStart - servedOffset;
  if (leadingBytes > 0) {
    const firstBytes = filesLargeTextCodePointByteLengthAtStart(content);
    if (firstBytes > leadingBytes) {
      // 服务只会在请求偏移位于合法码点内部时向前回退；丢掉整个首码点。
      offset = servedOffset + firstBytes;
      content = dropFirstCodePoint(content);
    }
  }

  const isLastBlock = nominalEnd >= totalBytes;
  if (isLastBlock) {
    return {
      blockIndex,
      offset,
      nextOffset: totalBytes,
      content,
      hasDecodingErrors: params.window.hasDecodingErrors === true,
      needsExactConfirmation: false,
    };
  }

  // 名义边界落在合法多字节码点内部时，真实结束位置必须由请求层的边界 probe 给出；
  // 非法正文的替换字符重新编码后长度会变化，不能参与原文件字节坐标计算。
  const resolvedEnd =
    params.knownEnd === undefined
      ? Math.min(nominalEnd, totalBytes)
      : Math.min(Math.max(normalizeBytes(params.knownEnd), offset), totalBytes);

  if (params.window.hasDecodingErrors !== true) {
    const bytes = encoder.encode(content);
    const boundary = nominalEnd - offset;
    // 服务起点回退 + 尾部回退可能让 raw 窗口止于 nominalEnd 之前（窗口仍未到
    // EOF 时）；此时窗口可能没有读到跨边界的完整码点，不能按已读长度提交，
    // 交给请求层 probe 后再精确重读。
    const rawEnd = servedOffset + normalizeBytes(params.window.bytesRead);
    if (
      params.exact !== true &&
      params.probeShortWindow === true &&
      params.window.truncated === true &&
      rawEnd < nominalEnd
    ) {
      return {
        blockIndex,
        offset,
        nextOffset: Math.min(rawEnd, totalBytes),
        content,
        hasDecodingErrors: false,
        needsExactConfirmation: true,
      };
    }
    const aligned = resolveFilesLargeTextAlignedBoundary(bytes, boundary);
    const cut = Math.max(0, Math.min(aligned, bytes.length));
    return {
      blockIndex,
      offset,
      nextOffset: offset + cut,
      content: decoder.decode(bytes.subarray(0, cut)),
      hasDecodingErrors: false,
      needsExactConfirmation: false,
    };
  }

  if (params.exact === true) {
    // 精确窗口的范围就是 [offset, knownEnd)，content 直接来自原始字节。
    return {
      blockIndex,
      offset,
      nextOffset: resolvedEnd,
      content,
      hasDecodingErrors: true,
      needsExactConfirmation: false,
    };
  }

  // 初次窗口的非法字节可能只存在于越界尾部；先给保守范围，等待精确复核。
  // 这里的裁剪只用于临时只读展示，不参与任何块坐标计算。
  return {
    blockIndex,
    offset,
    nextOffset: resolvedEnd,
    content: sliceDecodedContentApprox(content, resolvedEnd - offset),
    hasDecodingErrors: true,
    needsExactConfirmation: true,
  };
}
