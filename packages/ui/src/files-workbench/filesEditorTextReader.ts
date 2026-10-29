import {
  FILE_TEXT_WINDOW_CHANGED_CODE,
  FILE_TEXT_WINDOW_MAX_BYTES,
  type FileTextWindow,
} from "@zcode/shared";

/**
 * 文件工作台唯一的大文本读取决策与完整读取实现。
 *
 * 打开、恢复激活与保存冲突重载都必须经过 `readFilesTextForOpen`，不得各自判断
 * 大小阈值；保存前的完整冲突读取使用 `readFilesTextForSave`，同样复用窗口循环。
 * 单次窗口硬上限 256 KiB，> 8 MiB 的文件只读取首窗后交给只读窗口视图。
 */

/** `size ≤ 8 MiB` 完整读取后可编辑；超过即只读大文本。 */
export const FILES_EDITABLE_TEXT_MAX_BYTES = 8 * 1024 * 1024;

/** UI 只依赖窗口读取能力，本地 / Desktop / 远程工作区共用同一结构。 */
export interface FilesTextWindowReader {
  readTextFileWindow(params: {
    path: string;
    offset?: number;
    length?: number;
    expectedVersion?: string;
  }): Promise<FileTextWindow>;
}

export type FilesTextReadMode = "binary" | "editable" | "large-text";

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

export type FilesTextReadResult = FilesBinaryTextRead | FilesEditableTextRead | FilesLargeTextRead;

/** 读取期间版本变化 / 大小不一致；整次读取作废，不能提交半份正文。 */
export class FilesTextReadChangedError extends Error {
  readonly code = FILE_TEXT_WINDOW_CHANGED_CODE;

  constructor(message: string) {
    super(message);
    this.name = "FilesTextReadChangedError";
  }
}

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
  // 非法 UTF-8 会被解码为 U+FFFD，原字节无法从字符串还原；
  // 即使体积在阈值内也只能进入只读窗口，禁止保存回写造成数据损坏。
  if (params.hasDecodingErrors) {
    return "large-text";
  }
  return params.totalBytes > FILES_EDITABLE_TEXT_MAX_BYTES ? "large-text" : "editable";
}

function largeTextRead(firstWindow: FileTextWindow, reason?: "encoding"): FilesLargeTextRead {
  return {
    mode: "large-text",
    totalBytes: firstWindow.totalBytes,
    version: firstWindow.version,
    firstWindow,
    reason,
  };
}

function windowLength(): number {
  return FILE_TEXT_WINDOW_MAX_BYTES;
}

/**
 * 从首窗继续按 `nextOffset` 读到 EOF，所有后续窗口使用首窗 version。
 *
 * 任一步版本、总大小或偏移不连续都判整次失败，绝不拼接混合版本内容。
 */
async function readEditableWindows(
  reader: FilesTextWindowReader,
  path: string,
  firstWindow: FileTextWindow,
): Promise<FilesEditableTextRead | FilesLargeTextRead> {
  const totalBytes = firstWindow.totalBytes;
  const version = firstWindow.version;
  if (firstWindow.offset !== 0) {
    throw new FilesTextReadChangedError(
      `First text window did not start at offset 0: ${path} (${firstWindow.offset})`,
    );
  }
  if (totalBytes > FILES_EDITABLE_TEXT_MAX_BYTES) {
    throw new FilesTextReadChangedError(
      `File crossed the editable threshold while reading: ${path} (${totalBytes})`,
    );
  }

  const chunks = [firstWindow.content];
  let offset = firstWindow.nextOffset;
  let eof = firstWindow.eof;
  if (offset < firstWindow.offset || offset > totalBytes || eof !== (offset === totalBytes)) {
    throw new FilesTextReadChangedError(
      `First text window ended inconsistently: ${path} (${offset}/${totalBytes}, eof=${eof})`,
    );
  }
  // 8 MiB / 256 KiB = 32 窗；上限只用于防御异常服务不前进。
  for (let guard = 0; !eof; guard += 1) {
    if (guard > Math.ceil(totalBytes / windowLength()) + 4) {
      throw new FilesTextReadChangedError(`Text window did not reach EOF: ${path} (${offset})`);
    }
    let window: FileTextWindow;
    try {
      window = await reader.readTextFileWindow({
        path,
        offset,
        length: windowLength(),
        expectedVersion: version,
      });
    } catch (error) {
      // 首窗成功后才进入这里：后续窗口的 ENOENT 说明文件在完整读取期间被删除
      // 或替换，不能按「保存时目标不存在」重建文件，必须按版本变化整体失败。
      if (isFilesTextReadMissingError(error)) {
        throw new FilesTextReadChangedError(
          `File disappeared while reading complete text: ${path} (${offset})`,
        );
      }
      throw error;
    }
    if (
      window.version !== version ||
      window.totalBytes !== totalBytes ||
      window.offset !== offset ||
      window.isBinary
    ) {
      throw new FilesTextReadChangedError(
        `File changed while reading complete text: ${path} (${offset})`,
      );
    }
    if (
      window.nextOffset < offset ||
      window.nextOffset > totalBytes ||
      window.eof !== (window.nextOffset === totalBytes)
    ) {
      throw new FilesTextReadChangedError(
        `Text window ended inconsistently: ${path} (${offset} -> ${window.nextOffset}, eof=${window.eof})`,
      );
    }
    if (window.nextOffset <= offset && !window.eof) {
      throw new FilesTextReadChangedError(
        `Text window made no progress: ${path} (${offset} -> ${window.nextOffset})`,
      );
    }
    if (window.hasDecodingErrors === true) {
      // 后续窗口包含非法 UTF-8：此前读到的正文也不能作为可编辑全文提交。
      // 只保留首窗前缀给只读窗口，失败窗口及其后的正文不进入缓冲。
      return largeTextRead(firstWindow, "encoding");
    }
    chunks.push(window.content);
    offset = window.nextOffset;
    eof = window.eof;
  }
  if (offset !== totalBytes) {
    throw new FilesTextReadChangedError(
      `Text window ended before totalBytes: ${path} (${offset}/${totalBytes})`,
    );
  }

  return {
    mode: "editable",
    text: chunks.join(""),
    totalBytes,
    version,
  };
}

/** 打开 / 恢复 / 冲突重载共用的读取决策。 */
export async function readFilesTextForOpen(
  reader: FilesTextWindowReader,
  path: string,
): Promise<FilesTextReadResult> {
  const firstWindow = await reader.readTextFileWindow({
    path,
    offset: 0,
    length: windowLength(),
  });
  const mode = resolveFilesTextReadMode({
    isBinary: firstWindow.isBinary,
    totalBytes: firstWindow.totalBytes,
    hasDecodingErrors: firstWindow.hasDecodingErrors === true,
  });
  if (mode === "binary") {
    return {
      mode,
      totalBytes: firstWindow.totalBytes,
      version: firstWindow.version,
    };
  }
  if (mode === "large-text") {
    return largeTextRead(
      firstWindow,
      firstWindow.hasDecodingErrors === true ? "encoding" : undefined,
    );
  }
  return readEditableWindows(reader, path, firstWindow);
}

/**
 * 保存前的完整冲突读取。
 *
 * - 首窗已经是 `> 8 MiB`：立即返回 large-text，不继续读大文件；
 * - 否则从首窗读到 EOF，返回真正的完整磁盘正文，而不是首窗 256 KiB；
 * - 二进制同样只返回判定，调用方按冲突处理。
 */
export async function readFilesTextForSave(
  reader: FilesTextWindowReader,
  path: string,
): Promise<FilesTextReadResult> {
  const firstWindow = await reader.readTextFileWindow({
    path,
    offset: 0,
    length: windowLength(),
  });
  const mode = resolveFilesTextReadMode({
    isBinary: firstWindow.isBinary,
    totalBytes: firstWindow.totalBytes,
    hasDecodingErrors: firstWindow.hasDecodingErrors === true,
  });
  if (mode === "binary") {
    return {
      mode,
      totalBytes: firstWindow.totalBytes,
      version: firstWindow.version,
    };
  }
  if (mode === "large-text") {
    return largeTextRead(
      firstWindow,
      firstWindow.hasDecodingErrors === true ? "encoding" : undefined,
    );
  }
  return readEditableWindows(reader, path, firstWindow);
}
