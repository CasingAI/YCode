import {
  assertFirstTextWindow,
  readEditableWindows,
} from "@/files-workbench/filesTextWindowPipeline.js";
import {
  largeTextRead,
  resolveFilesTextReadMode,
  textWindowLength,
  tooLargeRead,
  FilesTextReadAbortedError,
  type FilesBinaryTextRead,
  type FilesEditableTextRead,
  type FilesLargeTextRead,
  type FilesTextReadCancelCheck,
  type FilesTextReadResult,
  type FilesTextWindowReader,
  type FilesTooLargeTextRead,
} from "@/files-workbench/filesTextReadTypes.js";

/**
 * 文件工作台唯一的文本读取决策入口。
 *
 * 普通合法 UTF-8 文本始终是一份连续完整文档：单次读取最多 256 KiB 只是 IO
 * 边界，不是用户编辑单位，因此不存在「按文件大小切成固定块」的路径。
 * 只有非法 UTF-8 才降级到固定块安全模型；超过受控大文本阈值时返回显式
 * `too-large`，不静默切块。
 *
 * 打开、恢复激活与保存冲突重载都必须经过 `readFilesTextForOpen`；保存前的
 * 完整冲突读取使用 `readFilesTextForSave`，两者复用同一决策与窗口流水线。
 *
 * 模块分层（均为本目录纯 helper，无 React / 服务依赖）：
 * - `filesTextReadLimits.ts`：阈值与并发上限常量；
 * - `filesTextReadTypes.ts`：读取结果类型、错误判定与读取模式判定；
 * - `filesTextWindowPipeline.ts`：有界并发窗口读取与按字节范围归并。
 */

export {
  FILES_FULL_TEXT_MAX_BYTES,
  FILES_TEXT_WINDOW_READ_BUDGET_FACTOR,
  FILES_TEXT_WINDOW_READ_BUDGET_SLACK,
  FILES_TEXT_WINDOW_READ_CONCURRENCY,
  FILES_TEXT_WINDOW_STEP_BYTES,
} from "@/files-workbench/filesTextReadLimits.js";
export {
  FilesTextReadAbortedError,
  FilesTextReadChangedError,
  isFilesTextReadAbortedError,
  isFilesTextReadChangedError,
  isFilesTextReadMissingError,
  resolveFilesTextReadMode,
} from "@/files-workbench/filesTextReadTypes.js";
export type {
  FilesBinaryTextRead,
  FilesEditableTextRead,
  FilesLargeTextRead,
  FilesTextReadCancelCheck,
  FilesTextReadMode,
  FilesTextReadResult,
  FilesTextWindowReader,
  FilesTooLargeTextRead,
} from "@/files-workbench/filesTextReadTypes.js";

async function readDecision(
  reader: FilesTextWindowReader,
  path: string,
  options?: { signal?: AbortSignal; isCancelled?: FilesTextReadCancelCheck },
): Promise<
  FilesBinaryTextRead | FilesTooLargeTextRead | FilesLargeTextRead | FilesEditableTextRead
> {
  // 已取消就不必发起哪怕一次请求（预览换源 / 卸载时常见）。
  if (options?.signal?.aborted === true || options?.isCancelled?.() === true) {
    throw new FilesTextReadAbortedError(`Text read aborted: ${path}`);
  }
  const firstWindow = await reader.readTextFileWindow({
    path,
    offset: 0,
    length: textWindowLength(),
  });
  // 决策本身也依赖首窗区间自洽：bytesRead 与 nextOffset - offset 不一致时，
  // 后续按字节范围裁剪的重叠前缀会把错位内容当成正文提交。
  assertFirstTextWindow(firstWindow, path);
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
  if (mode === "too-large") {
    // 超过受控上限：不读后续窗口，也不退化成固定块；UI 负责显示明确错误。
    return tooLargeRead(firstWindow);
  }
  if (mode === "large-text") {
    return largeTextRead(
      firstWindow,
      firstWindow.hasDecodingErrors === true ? "encoding" : undefined,
    );
  }
  return readEditableWindows(reader, path, firstWindow, options);
}

/**
 * 打开 / 恢复 / 冲突重载共用的读取决策。
 *
 * `signal` / `isCancelled` 只控制本端调度：已经发出的窗口请求会自然完成并被
 * 丢弃，不会跨 RPC 发送取消；取消后不再发起新请求，并以
 * {@link FilesTextReadAbortedError} 结束。
 */
export async function readFilesTextForOpen(
  reader: FilesTextWindowReader,
  path: string,
  options?: { signal?: AbortSignal; isCancelled?: FilesTextReadCancelCheck },
): Promise<FilesTextReadResult> {
  return readDecision(reader, path, options);
}

/**
 * 保存前的完整冲突读取。
 *
 * 与打开共用同一决策：合法 UTF-8 一直读到 EOF，返回真正的完整磁盘正文；
 * 非法 UTF-8 / 超过受控上限 / 二进制只返回判定，调用方按冲突处理。
 */
export async function readFilesTextForSave(
  reader: FilesTextWindowReader,
  path: string,
  options?: { signal?: AbortSignal; isCancelled?: FilesTextReadCancelCheck },
): Promise<FilesTextReadResult> {
  return readDecision(reader, path, options);
}
