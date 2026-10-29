import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, stat } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import {
  FILE_TEXT_WINDOW_CHANGED_CODE,
  FILE_TEXT_WINDOW_INVALID_RANGE_CODE,
  FILE_TEXT_WINDOW_MAX_BYTES,
  FILE_TEXT_WINDOW_NOT_FILE_CODE,
  type FileTextWindow,
  type FileTextWindowErrorCode,
} from "@zcode/shared";

/** 文件头二进制探测采样；尾窗口不按窗口内的零洞判定，避免大日志/稀疏文件被误判。 */
const BINARY_HEADER_SAMPLE_BYTES = 8 * 1024;
/** UTF-8 单个码点最多 4 字节；回溯 / 补完只需看前后 3 字节。 */
const UTF8_MAX_BYTES = 4;

interface ReadTextFileWindowParams {
  path: string;
  /** 请求的字节偏移；服务会向前回退对齐到 UTF-8 码点起始。默认 0。 */
  offset?: number;
  /** 请求字节数；最小 4，默认且最多 256KiB。 */
  length?: number;
  /** 与文件当前版本不一致时拒绝读取。 */
  expectedVersion?: string;
}

/**
 * 仅供 packages/services/test 在 open 与读取之间注入磁盘变化。
 * 不属于 IFileService 契约，RPC 代理只会传 params 一个参数。
 */
interface ReadTextFileWindowTestHooks {
  afterOpen?: () => Promise<void>;
}

class FileTextWindowError extends Error {
  readonly code: FileTextWindowErrorCode;

  constructor(code: FileTextWindowErrorCode, message: string) {
    super(message);
    this.name = "FileTextWindowError";
    this.code = code;
  }
}

function invalidRange(message: string): FileTextWindowError {
  return new FileTextWindowError(FILE_TEXT_WINDOW_INVALID_RANGE_CODE, message);
}

function notFile(path: string): FileTextWindowError {
  return new FileTextWindowError(FILE_TEXT_WINDOW_NOT_FILE_CODE, `Path is not a file: ${path}`);
}

function changed(path: string, detail: string): FileTextWindowError {
  return new FileTextWindowError(
    FILE_TEXT_WINDOW_CHANGED_CODE,
    `File changed while reading: ${path}${detail ? ` (${detail})` : ""}`,
  );
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** 合法 UTF-8 首字节对应的码点长度；非法首字节返回 0。 */
function utf8SequenceLength(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/**
 * 判断 index 是否位于一个合法 UTF-8 码点内部；是则返回该码点首字节下标。
 *
 * 只接受完整、合法的 2–4 字节序列：overlong、代理区、越界与截断都按非法字节处理。
 * 非法 continuation 串没有可回退的码点起点，返回 undefined，由调用方保持原边界。
 */
export function findValidUtf8CodePointStart(buffer: Buffer, index: number): number | undefined {
  const byte = byteAt(buffer, index);
  if (byte === undefined || !isUtf8Continuation(byte)) {
    return undefined;
  }
  // UTF-8 单码点最多 4 字节，首字节最远在 index - 3。
  const earliest = Math.max(0, index - (UTF8_MAX_BYTES - 1));
  for (let leadIndex = index - 1; leadIndex >= earliest; leadIndex -= 1) {
    const lead = byteAt(buffer, leadIndex);
    if (lead === undefined || isUtf8Continuation(lead)) {
      continue;
    }
    const length = utf8SequenceLength(lead);
    if (length === 0) {
      return undefined;
    }
    const end = leadIndex + length;
    // 首字节必须覆盖 index；序列不完整（EOF 截断）同样视为非法。
    if (end <= index || end > buffer.length) {
      return undefined;
    }
    return isUtf8(buffer.subarray(leadIndex, end)) ? leadIndex : undefined;
  }
  return undefined;
}

function byteAt(buffer: Buffer, index: number): number | undefined {
  return index >= 0 && index < buffer.length ? buffer[index] : undefined;
}

/**
 * 与既有 readTextFile 相同的文本 / 二进制识别规则。
 * 只用于文件头采样，避免把稀疏文件尾部的零字节当成整份文件二进制。
 */
function isProbablyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }
  let suspiciousBytes = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const value = buffer[index];
    if (value === undefined) {
      break;
    }
    if (value === 0) {
      return true;
    }
    const isCommonWhitespace = value === 9 || value === 10 || value === 12 || value === 13;
    const isControlChar =
      (value >= 1 && value <= 8) || (value >= 14 && value <= 31) || value === 127;
    if (!isCommonWhitespace && isControlChar) {
      suspiciousBytes += 1;
    }
  }
  return suspiciousBytes / buffer.length > 0.3;
}

/**
 * 版本 token 由打开后的 fstat identity 生成。
 * 不暴露路径或本地时钟，调用方只把它当不透明字符串回传。
 */
export function statVersion(stats: BigIntStats): string {
  return `fstw1:${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

async function readAt(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  if (length <= 0) {
    return Buffer.alloc(0);
  }
  const buffer = Buffer.allocUnsafe(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const result = await handle.read(buffer, bytesRead, length - bytesRead, position + bytesRead);
    if (result.bytesRead <= 0) {
      break;
    }
    bytesRead += result.bytesRead;
  }
  return buffer.subarray(0, bytesRead);
}

async function readBinaryFlag(handle: FileHandle, totalBytes: number): Promise<boolean> {
  if (totalBytes === 0) {
    return false;
  }
  const sample = await readAt(handle, Math.min(BINARY_HEADER_SAMPLE_BYTES, totalBytes), 0);
  return isProbablyBinary(sample);
}

/**
 * 所有返回分支（含 EOF 空窗口）统一做读取后校验：
 * 1. 打开句柄的 fstat 必须与读取前 identity 一致，防止同一 inode 被改写；
 * 2. 路径再次 stat 必须仍是同一 identity，防止 atomic rename 替换或删除。
 * 路径不存在或 identity 不同都按 FILE_TEXT_WINDOW_CHANGED 拒绝，避免返回混合版本。
 */
async function finalizeValidation(
  handle: FileHandle,
  path: string,
  beforeVersion: string,
): Promise<void> {
  const afterHandle = await handle.stat({ bigint: true }).catch(() => undefined);
  if (afterHandle === undefined || statVersion(afterHandle) !== beforeVersion) {
    throw changed(path, "open handle changed during read");
  }
  let afterPath: BigIntStats;
  try {
    afterPath = await stat(path, { bigint: true });
  } catch {
    throw changed(path, "path disappeared during read");
  }
  if (statVersion(afterPath) !== beforeVersion) {
    throw changed(path, "path identity changed during read");
  }
}

/**
 * 把请求偏移对齐到 UTF-8 码点起始：
 * - offset 已是码点起点或普通字节：原样返回；
 * - offset 位于合法多字节码点内部：回退到该码点首字节；
 * - offset 位于非法 continuation 串中：保持请求值，把它当作确定边界。
 *
 * 非法串不能回退，否则固定块按 `BLOCK_STEP` 计算的边界会重叠；固定块需要从
 * 非法字节处精确开始，而不是向前吞掉上一块尾部。
 */
async function resolveAlignedStart(
  handle: FileHandle,
  offset: number,
  totalBytes: number,
): Promise<number> {
  if (offset <= 0) {
    return 0;
  }
  // 多读 4 字节用于验证 index 所在码点的完整序列（首字节最远在 index - 3）。
  const probeStart = Math.max(0, offset - (UTF8_MAX_BYTES - 1));
  const probeEnd = Math.min(totalBytes, offset + UTF8_MAX_BYTES);
  const probeLength = probeEnd - probeStart;
  if (probeLength <= 0) {
    return Math.min(offset, totalBytes);
  }
  const probe = await readAt(handle, probeLength, probeStart);
  const leadIndex = findValidUtf8CodePointStart(probe, offset - probeStart);
  return leadIndex === undefined ? offset : probeStart + leadIndex;
}

/**
 * 解析窗口实际结束位置（绝对字节）：
 * - desiredEnd 已是边界则原样返回；
 * - 落在合法多字节码点内部时回退到码点起始，把完整码点留给下一窗口；
 * - 落在非法 continuation 串中时保持 desiredEnd，非法字节不被丢弃或重新编码。
 */
function resolveWindowEnd(
  buffer: Buffer,
  alignedStart: number,
  relativeDesiredEnd: number,
  totalBytes: number,
): number {
  const desiredEnd = alignedStart + relativeDesiredEnd;
  if (desiredEnd >= totalBytes) {
    return totalBytes;
  }
  const leadIndex = findValidUtf8CodePointStart(buffer, relativeDesiredEnd);
  return leadIndex === undefined ? desiredEnd : alignedStart + leadIndex;
}

/**
 * length 最小 4 字节，保证一个完整 UTF-8 码点放得下；结束位置最坏回退到请求 offset 之前时，
 * 这里只推进到 requestedOffset + 1（仍不超过 alignedStart + length），避免死循环且不突破 length。
 */
function ensureProgress(
  end: number,
  alignedStart: number,
  requestedOffset: number,
  readLength: number,
  totalBytes: number,
): number {
  if (end > requestedOffset) {
    return end;
  }
  const minimumEnd = Math.min(totalBytes, requestedOffset + 1);
  // readLength >= 4 且 requestedOffset - alignedStart <= 3，因此该上限不会突破请求窗口。
  return Math.min(Math.max(end, minimumEnd), alignedStart + readLength);
}

/**
 * 读取一段带版本、UTF-8 边界安全的有界文本窗口。
 *
 * 顺序：
 * open -> fstat(prev) -> expectedVersion 校验 -> 头采样 -> 对齐 + read
 *      -> fstat(after) -> 路径 stat 复核 -> close
 *
 * 不保留常驻 handle 或整文件缓存；每次调用独立，适合本地、Desktop 与远程工作区
 * 共用同一 typed RPC。任何阶段失败都不会返回上半段旧版本内容。
 */
export async function readTextFileWindow(
  params: ReadTextFileWindowParams,
  testHooks?: ReadTextFileWindowTestHooks,
): Promise<FileTextWindow> {
  const { path } = params;
  if (typeof path !== "string" || path.trim().length === 0) {
    throw invalidRange("Path is required.");
  }
  const requestedOffset = params.offset ?? 0;
  const requestedLength = params.length ?? FILE_TEXT_WINDOW_MAX_BYTES;
  if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0) {
    throw invalidRange(`Invalid text window offset: ${String(params.offset)}`);
  }
  if (!Number.isSafeInteger(requestedLength) || requestedLength < UTF8_MAX_BYTES) {
    throw invalidRange(
      `Text window length must be at least ${UTF8_MAX_BYTES}: ${String(params.length)}`,
    );
  }
  const readLength = Math.min(requestedLength, FILE_TEXT_WINDOW_MAX_BYTES);

  // 带 expectedVersion 说明调用方已持有该文件版本，此时 open 的 ENOENT 属于读取开始后
  // 文件消失，必须按版本变化拒绝；否则保存流程会把后续窗口的缺失误判为初始缺失并重建文件。
  // 无 expectedVersion 的初读仍透传 ENOENT；EACCES、ENOTDIR 等其它错误保持原样。
  const handle = await open(path, "r").catch((error: unknown) => {
    if (params.expectedVersion !== undefined && isEnoent(error)) {
      throw changed(path, "path disappeared before open");
    }
    throw error;
  });
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw notFile(path);
    }
    const version = statVersion(before);
    if (params.expectedVersion !== undefined && params.expectedVersion !== version) {
      throw changed(path, "expected version mismatch");
    }
    const totalBytes = Number(before.size);
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
      throw invalidRange(`File size is not a safe byte offset: ${String(before.size)}`);
    }
    await testHooks?.afterOpen?.();

    const isBinary = await readBinaryFlag(handle, totalBytes);
    if (requestedOffset >= totalBytes) {
      await finalizeValidation(handle, path, version);
      return {
        path,
        content: "",
        offset: totalBytes,
        bytesRead: 0,
        nextOffset: totalBytes,
        totalBytes,
        version,
        isBinary,
        eof: true,
        hasDecodingErrors: false,
        truncated: false,
      };
    }

    const alignedStart = await resolveAlignedStart(handle, requestedOffset, totalBytes);
    const desiredEnd = Math.min(totalBytes, alignedStart + readLength);
    // 多读最多 4 字节：用于判断 desiredEnd 是否处于 continuation，并给结束边界回看留出余量。
    const readSize = Math.min(
      totalBytes - alignedStart,
      desiredEnd - alignedStart + UTF8_MAX_BYTES,
    );
    const buffer = await readAt(handle, readSize, alignedStart);
    const relativeDesiredEnd = Math.min(desiredEnd - alignedStart, buffer.length);
    const resolvedEnd = resolveWindowEnd(buffer, alignedStart, relativeDesiredEnd, totalBytes);
    const end = Math.min(
      ensureProgress(resolvedEnd, alignedStart, requestedOffset, readLength, totalBytes),
      alignedStart + buffer.length,
    );
    const bytesRead = Math.max(0, end - alignedStart);
    const rawWindow = buffer.subarray(0, bytesRead);
    // 只对实际返回的原始窗口字节做 UTF-8 校验：文件里真实的 U+FFFD 是合法编码，
    // 不会误报；二进制窗口不进入文本缓冲，统一为 false。
    const hasDecodingErrors = !isBinary && bytesRead > 0 && !isUtf8(rawWindow);
    await finalizeValidation(handle, path, version);

    const eof = end >= totalBytes;
    return {
      path,
      content: isBinary ? "" : rawWindow.toString("utf8"),
      offset: alignedStart,
      bytesRead,
      nextOffset: end,
      totalBytes,
      version,
      isBinary,
      eof,
      hasDecodingErrors,
      truncated: !eof,
    };
  } finally {
    await handle.close();
  }
}
