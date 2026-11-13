import type { FileTextSlice } from "@zcode/shared";
import {
  readFilesTextForOpen,
  type FilesTextReadResult,
  type FilesTextWindowReader,
} from "@/files-workbench/filesEditorTextReader.js";
import { FILE_VIEWER_MAX_TEXT_BYTES } from "@/lib/codeViewer.js";

/**
 * Side Pane 文本预览的读取与展示决策。
 *
 * 正常路径复用文件工作台的 `readFilesTextForOpen`：合法 UTF-8 文本按窗口读到
 * EOF，非法 UTF-8 才降级为只读前缀；预览不得再自行用 256 KiB `truncated`
 * 清空正文或按文件大小报「文件过大」。
 */

export interface PreviewPaneLegacyTextReader {
  readTextFile(params: { path: string; offset?: number; length?: number }): Promise<FileTextSlice>;
}

export type PreviewPaneTextReader = FilesTextWindowReader & PreviewPaneLegacyTextReader;

export type PreviewPaneTextRead =
  | { kind: "window"; result: FilesTextReadResult }
  | { kind: "legacy"; slice: FileTextSlice; truncated: boolean };

export interface PreviewPaneTextReadState {
  filePreview: FileTextSlice;
  /** 只展示已读前缀，正文不完整。 */
  truncated: boolean;
  /** 原始字节含非法 UTF-8；只读预览，禁止写回。 */
  encodingInvalid: boolean;
  /** 合法 UTF-8 但超过渲染进程单字符串硬上限，只能展示首窗前缀。 */
  tooLarge: boolean;
}

export type PreviewPaneTextNoticeId =
  | "codeViewer.textPreviewEncoding"
  | "codeViewer.textPreviewTruncated"
  | "codeViewer.textPreviewTooLarge";

const TEXT_WINDOW_METHOD_MISSING_PATTERN = /Method not found:\s*readTextFileWindow/i;

/**
 * 只有「服务端没有 readTextFileWindow」才回退旧读取。
 * 读取失败、版本变化等真实错误必须继续抛出，不能退化成旧快照。
 */
export function isPreviewTextWindowUnavailableError(error: unknown): boolean {
  return error instanceof Error && TEXT_WINDOW_METHOD_MISSING_PATTERN.test(error.message);
}

export async function readPreviewPaneText(
  reader: PreviewPaneTextReader,
  path: string,
): Promise<PreviewPaneTextRead> {
  try {
    return {
      kind: "window",
      result: await readFilesTextForOpen(reader, path),
    };
  } catch (error) {
    if (!isPreviewTextWindowUnavailableError(error)) {
      throw error;
    }
    // 旧 Host 兼容：保留既有 readTextFile 上限，但把已读前缀交给预览，
    // 不再因 truncated 清空正文。
    const slice = await reader.readTextFile({
      path,
      offset: 0,
      length: FILE_VIEWER_MAX_TEXT_BYTES,
    });
    return { kind: "legacy", slice, truncated: slice.truncated };
  }
}

function sliceFromWindow(window: {
  path: string;
  content: string;
  offset: number;
  bytesRead: number;
  totalBytes: number;
  eof: boolean;
  isBinary: boolean;
}): FileTextSlice {
  return {
    path: window.path,
    content: window.content,
    offset: window.offset,
    bytesRead: window.bytesRead,
    totalBytes: window.totalBytes,
    truncated: !window.eof,
    isBinary: window.isBinary,
  };
}

export function resolvePreviewPaneTextReadState(
  read: PreviewPaneTextRead,
  path: string,
): PreviewPaneTextReadState {
  if (read.kind === "legacy") {
    return {
      filePreview: read.slice,
      truncated: read.truncated || read.slice.truncated,
      encodingInvalid: false,
      tooLarge: false,
    };
  }

  const result = read.result;
  if (result.mode === "binary") {
    return {
      filePreview: {
        path,
        content: "",
        offset: 0,
        bytesRead: 0,
        totalBytes: result.totalBytes,
        truncated: false,
        isBinary: true,
      },
      truncated: false,
      encodingInvalid: false,
      tooLarge: false,
    };
  }

  if (result.mode === "editable") {
    return {
      filePreview: {
        path,
        content: result.text,
        offset: 0,
        bytesRead: result.totalBytes,
        totalBytes: result.totalBytes,
        truncated: false,
        isBinary: false,
      },
      truncated: false,
      encodingInvalid: false,
      tooLarge: false,
    };
  }

  if (result.mode === "too-large") {
    // 合法 UTF-8 但超过单字符串硬上限：只展示首窗前缀，不伪造完整正文。
    return {
      filePreview: sliceFromWindow(result.firstWindow),
      truncated: true,
      encodingInvalid: false,
      tooLarge: true,
    };
  }

  return {
    filePreview: sliceFromWindow(result.firstWindow),
    truncated: !result.firstWindow.eof,
    encodingInvalid: result.reason === "encoding" || result.firstWindow.hasDecodingErrors === true,
    tooLarge: false,
  };
}

export function resolvePreviewPaneTextNoticeIds(
  state: Pick<PreviewPaneTextReadState, "truncated" | "encodingInvalid" | "tooLarge">,
): PreviewPaneTextNoticeId[] {
  // 三种前缀原因互斥：编码错误、单字符串硬上限、旧 Host 不支持分段读取。
  // 编码错误本身就会导致 truncated，不能因此再叠加一条 Host 能力提示。
  if (state.tooLarge) {
    return ["codeViewer.textPreviewTooLarge"];
  }
  if (state.encodingInvalid) {
    return ["codeViewer.textPreviewEncoding"];
  }
  if (state.truncated) {
    return ["codeViewer.textPreviewTruncated"];
  }
  return [];
}

/** 超过该字符数直接进入虚拟行视图，避免一次生成几十万行 DOM。 */
export const PREVIEW_VIRTUAL_TEXT_MIN_CHARS = 1024 * 1024;
/** 小文件也可能因超多换行导致 CodeViewer 生成过多行。 */
export const PREVIEW_VIRTUAL_TEXT_MAX_LINES = 20_000;

export function countPreviewTextLines(text: string): number {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lines += 1;
      if (lines > PREVIEW_VIRTUAL_TEXT_MAX_LINES) {
        return lines;
      }
    }
  }
  return lines;
}

export function shouldUseVirtualizedPreviewText(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  if (text.length > PREVIEW_VIRTUAL_TEXT_MIN_CHARS) {
    return true;
  }
  return countPreviewTextLines(text) > PREVIEW_VIRTUAL_TEXT_MAX_LINES;
}
