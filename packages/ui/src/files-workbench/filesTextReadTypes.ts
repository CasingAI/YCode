import {
  FILE_TEXT_WINDOW_CHANGED_CODE,
  FILE_TEXT_WINDOW_MAX_BYTES,
  type FileTextWindow,
} from "@zcode/shared";
import { FILES_FULL_TEXT_MAX_BYTES } from "@/files-workbench/filesTextReadLimits.js";

/**
 * 文本读取的类型、错误与决策判定。
 *
 * 单次磁盘读取上限、阈值常量见 `filesTextReadLimits.ts`；并发窗口流水线见
 * `filesTextWindowPipeline.ts`。本文件只保留纯判定，便于独立测试与复用。
 */

/** UI 只依赖窗口读取能力，本地 / Desktop / 远程工作区共用同一结构。 */
export interface FilesTextWindowReader {
  readTextFileWindow(params: {
    path: string;
    offset?: number;
    length?: number;
    expectedVersion?: string;
  }): Promise<FileTextWindow>;
}

export type FilesTextReadMode = "binary" | "editable" | "large-text" | "too-large";

export interface FilesBinaryTextRead {
  mode: "binary";
  totalBytes: number;
  version: string;
}

export interface FilesEditableTextRead {
  mode: "editable";
  text: string;
  totalBytes: number;
  version: string;
}

export interface FilesLargeTextRead {
  mode: "large-text";
  totalBytes: number;
  version: string;
  /**
   * 决策读取的首页窗口。调用方可以交给大文本 controller 作为初始窗口，
   * 但不得把它写入可编辑缓冲的 `text` / `savedText` 或持久化。
   */
  firstWindow: FileTextWindow;
  /** 因窗口原始字节存在非法 UTF-8 而降级只读；仅用于 UI 提示。 */
  reason?: "encoding";
}

/**
 * 合法 UTF-8 但超过受控大文本阈值：明确拒绝完整正文，也不回退固定块。
 * UI 必须显示 `loadError: "too-large"`，不能构造半份正文。
 */
export interface FilesTooLargeTextRead {
  mode: "too-large";
  totalBytes: number;
  version: string;
  /** 决策读取的首页窗口；只读预览可展示前缀，编辑路径不得据此构造正文。 */
  firstWindow: FileTextWindow;
  /** 与 large-text 结果保持同一只读前缀形状；too-large 不因编码问题触发。 */
  reason?: undefined;
}

export type FilesTextReadResult =
  | FilesBinaryTextRead
  | FilesEditableTextRead
  | FilesLargeTextRead
  | FilesTooLargeTextRead;

/** 读取期间版本变化 / 大小不一致；整次读取作废，不能提交半份正文。 */
export class FilesTextReadChangedError extends Error {
  readonly code = FILE_TEXT_WINDOW_CHANGED_CODE;

  constructor(message: string) {
    super(message);
    this.name = "FilesTextReadChangedError";
  }
}

/**
 * 调用方主动取消（预览换源 / 卸载、编辑器关闭）。
 *
 * 不跨 RPC 发送取消：已在途的窗口请求会自然完成并被丢弃，调度端在发现取消后
 * 不再发出新请求。调用方应把该错误当作「结果已过期」直接忽略，而不是展示错误。
 *
 * 使用独立的 `code`，避免被 `isFilesTextReadChangedError` 误判成「文件被修改」。
 */
export class FilesTextReadAbortedError extends Error {
  readonly code = "FILE_TEXT_READ_ABORTED" as const;

  constructor(message = "Text read aborted") {
    super(message);
    this.name = "FilesTextReadAbortedError";
  }
}

export function isFilesTextReadAbortedError(error: unknown): boolean {
  return (
    error instanceof FilesTextReadAbortedError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "FILE_TEXT_READ_ABORTED")
  );
}

/** 取消检查：返回 true 时停止调度后续窗口并抛出 {@link FilesTextReadAbortedError}。 */
export type FilesTextReadCancelCheck = () => boolean;

export function isFilesTextReadChangedError(error: unknown): boolean {
  return (
    error instanceof FilesTextReadChangedError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === FILE_TEXT_WINDOW_CHANGED_CODE)
  );
}

/**
 * 只有明确的「文件不存在」（ENOENT）才能按新建文件保存。
 * ENOTDIR 说明路径中间某一级不是目录，属于父路径错误而不是目标缺失；
 * 离线、权限、远程断开等读取失败同样不能被当作不存在覆盖。
 */
export function isFilesTextReadMissingError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT";
}

export function resolveFilesTextReadMode(params: {
  isBinary: boolean;
  totalBytes: number;
  hasDecodingErrors?: boolean;
}): FilesTextReadMode {
  if (params.isBinary) {
    return "binary";
  }
  // 非法 UTF-8 会被解码为 U+FFFD，原字节无法从字符串还原；即使体积很小也只能
  // 进入固定块安全模型，禁止完整正文保存回写造成数据损坏。
  if (params.hasDecodingErrors) {
    return "large-text";
  }
  // 单一保守字节上限：UTF-8 字节数 ≥ UTF-16 code unit 数，因此超过它既放不进
  // V8 单字符串，也进不了 Monaco 可操作范围。超过只代表主动拒绝，不保证字符数
  // 一定超限（3/4 字节字符为主时可能仍放得下）。
  if (params.totalBytes > FILES_FULL_TEXT_MAX_BYTES) {
    return "too-large";
  }
  return "editable";
}

export function largeTextRead(
  firstWindow: FileTextWindow,
  reason?: "encoding",
): FilesLargeTextRead {
  return {
    mode: "large-text",
    totalBytes: firstWindow.totalBytes,
    version: firstWindow.version,
    firstWindow,
    reason,
  };
}

export function tooLargeRead(firstWindow: FileTextWindow): FilesTooLargeTextRead {
  return {
    mode: "too-large",
    totalBytes: firstWindow.totalBytes,
    version: firstWindow.version,
    firstWindow,
  };
}

export function textWindowLength(): number {
  return FILE_TEXT_WINDOW_MAX_BYTES;
}
