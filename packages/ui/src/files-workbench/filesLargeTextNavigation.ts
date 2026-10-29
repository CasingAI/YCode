import { FILE_TEXT_WINDOW_MAX_BYTES } from "@zcode/shared";
import {
  FILES_LARGE_TEXT_BLOCK_STEP,
  filesLargeTextBlockCount,
  filesLargeTextBlockIndex,
  filesLargeTextNominalBlockEnd,
  filesLargeTextNominalBlockStart,
} from "@/files-workbench/filesLargeTextBlockModel.js";

/**
 * 大文本只读窗口的纯导航计算。
 *
 * 所有位置都是字节偏移；窗口大小固定为文件服务单次硬上限。这里不读盘、不持有
 * 窗口正文，只把「用户意图 + 当前窗口」换算成下一次请求的 offset，供窗口 store
 * 与交互组件共用，避免各处重复实现边界夹紧。
 */

export type FilesLargeTextNavigationTarget =
  | { kind: "start" }
  | { kind: "previous" }
  | { kind: "next" }
  | { kind: "end" }
  | { kind: "percent"; percent: number }
  | { kind: "offset"; offset: number };

export interface FilesLargeTextWindowPosition {
  offset: number;
  nextOffset: number;
  totalBytes: number;
  eof: boolean;
}

/** 兼容旧调用名的单一来源别名；块数学始终来自核心 block model。 */
export const FILES_LARGE_TEXT_BLOCK_STEP_BYTES = FILES_LARGE_TEXT_BLOCK_STEP;

export function clampFilesLargeTextOffset(offset: number, totalBytes: number): number {
  if (!Number.isFinite(offset) || totalBytes <= 0) {
    return 0;
  }
  return Math.min(Math.max(0, Math.floor(offset)), Math.max(0, Math.floor(totalBytes)));
}

export function clampFilesLargeTextPercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 0;
  }
  return Math.min(100, Math.max(0, percent));
}

/**
 * 把导航意图换算成请求起始字节。
 *
 * - `end` 使用一个有界尾窗，不扫描文件；大于 1 GiB 的稀疏文件也只读这一窗。
 * - `percent` 是字节百分比，不是行百分比。
 * - `next` 使用当前结果的精确 `nextOffset`，不重新计算窗口长度。
 */
export function resolveFilesLargeTextNavigationOffset(params: {
  target: FilesLargeTextNavigationTarget;
  current?: FilesLargeTextWindowPosition;
  totalBytes: number;
}): number {
  const totalBytes = Math.max(0, Math.floor(params.totalBytes));
  switch (params.target.kind) {
    case "start":
      return 0;
    case "previous": {
      if (!params.current) return 0;
      // 首窗继续向前是空操作，避免再读一次同一片段。
      return params.current.offset <= 0
        ? params.current.offset
        : Math.max(0, params.current.offset - FILE_TEXT_WINDOW_MAX_BYTES);
    }
    case "next": {
      if (!params.current) return 0;
      // EOF 后继续向后不能请求 totalBytes 空窗覆盖当前尾窗；显式偏移仍可定位 EOF。
      return params.current.eof
        ? params.current.offset
        : clampFilesLargeTextOffset(params.current.nextOffset, totalBytes);
    }
    case "end":
      return Math.max(0, totalBytes - FILE_TEXT_WINDOW_MAX_BYTES);
    case "percent":
      return clampFilesLargeTextOffset(
        Math.floor((totalBytes * clampFilesLargeTextPercent(params.target.percent)) / 100),
        totalBytes,
      );
    case "offset":
      return clampFilesLargeTextOffset(params.target.offset, totalBytes);
  }
}

/** 原文件字节偏移落在哪个固定块；直接复用核心数学。 */
export function resolveFilesLargeTextBlockIndex(offset: number): number {
  return filesLargeTextBlockIndex(offset);
}

/** 块的名义起点；实际起点由核心 slice 对齐到合法 UTF-8 码点之后。 */
export function resolveFilesLargeTextBlockNominalOffset(blockIndex: number): number {
  return filesLargeTextNominalBlockStart(blockIndex);
}

/** 最后一个含字节的块；空文件固定为 0，避免出现负索引或额外空块。 */
export function resolveFilesLargeTextLastBlockIndex(totalBytes: number): number {
  return filesLargeTextBlockCount(totalBytes) - 1;
}

/** 名义块区间 `[start, end)`；只用于导航与展示，实际边界以加载器对齐结果为准。 */
export function resolveFilesLargeTextBlockNominalRange(params: {
  blockIndex: number;
  totalBytes: number;
}): { start: number; end: number } {
  const start = filesLargeTextNominalBlockStart(params.blockIndex);
  const totalBytes = Number.isFinite(params.totalBytes)
    ? Math.max(0, Math.floor(params.totalBytes))
    : 0;
  return { start, end: Math.min(filesLargeTextNominalBlockEnd(params.blockIndex), totalBytes) };
}

export interface FilesLargeTextBlockNavigation {
  /** 目标块索引；定位与请求都以它为准。 */
  blockIndex: number;
  /** 最小边界探查的请求 offset（名义起点）。 */
  requestOffset: number;
}

/**
 * 把导航意图换算成固定块索引。
 *
 * - 块索引按原文件字节坐标计算，不因用户编辑改变其它块位置。
 * - `previous` / `next` 只在已有当前块时移动；首次加载与空文件都停在 block 0。
 * - `end` 选最后一个含字节的块；显式字节 / 百分比仍按 `floor(target / step)` 选块，
 *   便于定位到 EOF 追加块（`totalBytes` 正好落在块边界时）。
 */
export function resolveFilesLargeTextBlockNavigation(params: {
  target: FilesLargeTextNavigationTarget;
  currentBlockIndex?: number;
  totalBytes: number;
}): FilesLargeTextBlockNavigation {
  const totalBytes = Number.isFinite(params.totalBytes)
    ? Math.max(0, Math.floor(params.totalBytes))
    : 0;
  const lastIndex = resolveFilesLargeTextLastBlockIndex(totalBytes);
  const current = params.currentBlockIndex;
  let blockIndex: number;
  switch (params.target.kind) {
    case "start":
      blockIndex = 0;
      break;
    case "previous":
      blockIndex = current === undefined ? 0 : Math.max(0, current - 1);
      break;
    case "next":
      blockIndex = current === undefined ? 0 : Math.min(lastIndex, current + 1);
      break;
    case "end":
      blockIndex = lastIndex;
      break;
    case "percent": {
      const offset = clampFilesLargeTextOffset(
        Math.floor((totalBytes * clampFilesLargeTextPercent(params.target.percent)) / 100),
        totalBytes,
      );
      blockIndex = resolveFilesLargeTextBlockIndex(offset);
      break;
    }
    case "offset":
      blockIndex = resolveFilesLargeTextBlockIndex(
        clampFilesLargeTextOffset(params.target.offset, totalBytes),
      );
      break;
  }
  return {
    blockIndex,
    requestOffset: resolveFilesLargeTextBlockNominalOffset(blockIndex),
  };
}

/** 当前窗口位于文件头 / 中间 / 文件尾；空文件单独标记。 */
export function resolveFilesLargeTextPosition(
  window: Pick<FilesLargeTextWindowPosition, "offset" | "nextOffset" | "totalBytes" | "eof">,
): "empty" | "head" | "middle" | "tail" {
  if (window.totalBytes === 0) {
    return "empty";
  }
  if (window.offset <= 0) {
    return "head";
  }
  if (window.eof || window.nextOffset >= window.totalBytes) {
    return "tail";
  }
  return "middle";
}

/** 只要窗口不是从 0 开始或尚未到 EOF，就必须标明是片段。 */
export function isFilesLargeTextFragment(
  window: Pick<FilesLargeTextWindowPosition, "offset" | "eof">,
): boolean {
  return window.offset > 0 || !window.eof;
}

/**
 * 普通窗口读取的默认版本策略：首次读取不传，普通导航带当前版本。
 * 有脏草稿时 window store 会优先使用 `edit.baseVersion`，而不是这里的兜底。
 */
export function resolveFilesLargeTextExpectedVersion(params: {
  reason: "initial" | "navigate" | "refresh" | "retry";
  currentVersion?: string;
}): string | undefined {
  if (params.reason === "refresh" || params.reason === "initial") {
    return undefined;
  }
  return params.currentVersion;
}

export function formatFilesLargeTextRange(range: { offset: number; nextOffset: number }): string {
  return `[${range.offset}, ${range.nextOffset})`;
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** 固定二进制单位格式化；精确字节数仍由调用方一并展示。 */
export function formatFilesLargeTextByteCount(bytes: number): string {
  const value = Math.max(0, bytes);
  if (value < 1024) {
    return `${Math.floor(value)} B`;
  }
  let unitIndex = 0;
  let scaled = value;
  while (scaled >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${BYTE_UNITS[unitIndex]}`;
}

/** 文件监视路径比较使用统一的斜杠与 Windows 盘符大小写。 */
export function normalizeFilesLargeTextWatchPath(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

/**
 * 目录级 watcher 可能不带 `changedPath`；缺省时保守视为可能命中。
 * 明确指向其他文件的事件不能把当前窗口标成 stale。
 */
export function isFilesLargeTextWatchEventForPath(
  event: { changedPath?: string },
  path: string,
): boolean {
  if (!event.changedPath) return true;
  return (
    normalizeFilesLargeTextWatchPath(event.changedPath) === normalizeFilesLargeTextWatchPath(path)
  );
}

export interface FilesLargeTextRequestIdentity {
  bufferId: string;
  workspaceKey: string;
  remoteSessionId: string;
  path: string;
  generation: number;
  requestSeq: number;
}

/**
 * 迟到结果只有在完整身份与最新序号都一致时才可以提交。
 *
 * A→B→A 复用同一缓冲 ID 时，generation 或 requestSeq 已经前进，旧请求必须丢弃。
 */
export function isFilesLargeTextRequestCurrent(
  request: FilesLargeTextRequestIdentity,
  current: FilesLargeTextRequestIdentity,
): boolean {
  return (
    request.bufferId === current.bufferId &&
    request.workspaceKey === current.workspaceKey &&
    request.remoteSessionId === current.remoteSessionId &&
    request.path === current.path &&
    request.generation === current.generation &&
    request.requestSeq === current.requestSeq
  );
}
