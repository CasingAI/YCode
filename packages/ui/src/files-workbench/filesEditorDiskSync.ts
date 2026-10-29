import {
  FILE_TEXT_WINDOW_CHANGED_CODE,
  type FileTextWindow,
} from "@zcode/shared";
import {
  filesWorkspaceKey,
  findFilesBuffer,
  isFilesBufferDirty,
  isFilesTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import { isFilesEditorBufferActiveInLayout } from "@/files-workbench/filesEditorStoreLayout.js";
import type { FilesEditorLayoutState } from "@/files-workbench/filesEditorLayout.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";
import type {
  FilesBuffer,
  FilesEditorState,
  FilesExternalChange,
  FilesTextBuffer,
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";

/**
 * 普通文本缓冲的外部变化探测（纯函数 + 一次可测试的 probe）。
 *
 * 大型只读块由 viewer 的 range store 自己监视；这里只服务已加载的完整文本，
 * 避免同一路径出现两个语义不同的 watcher。探测失败不能把文件当成删除：
 * 只有明确 ENOENT 才标记 deleted。
 */

export interface FilesDiskSyncTarget {
  id: string;
  path: string;
  workspace: FilesWorkspaceRef;
  diskVersion?: string;
  dirty: boolean;
}

export interface FilesDiskSyncGroup {
  key: string;
  directory: string;
  workspace: FilesWorkspaceRef;
  targets: FilesDiskSyncTarget[];
}

export function filesDiskTargetIdentity(target: {
  workspace: FilesWorkspaceRef;
}): string {
  return `${filesWorkspaceKey(target.workspace)}\u0000${target.workspace.workspaceRemoteSessionId?.trim() ?? ""}`;
}

export function resolveFilesDiskWatchDirectory(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (separator < 0) return path;
  const parent = trimmed.slice(0, separator);
  if (parent === "") return trimmed.slice(0, 1);
  // Windows 盘符根：C: 需要补回分隔符，才能作为可监视目录。
  return /^[a-zA-Z]:$/.test(parent) ? `${parent}\\` : parent;
}

/** 监视路径比较使用统一的斜杠与 Windows 盘符大小写。 */
export function normalizeFilesDiskWatchPath(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

/** 目录级 watcher 可能不带 changedPath；缺省时保守视为可能命中。 */
export function isFilesDiskWatchEventForPath(
  event: { changedPath?: string },
  path: string,
): boolean {
  if (!event.changedPath) return true;
  return (
    normalizeFilesDiskWatchPath(event.changedPath) === normalizeFilesDiskWatchPath(path)
  );
}

const OFFLINE_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

export function isFilesDiskOfflineError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && OFFLINE_ERROR_CODES.has(code)) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /remote-workspace-disconnected|ECC?ONN|ENOTFOUND|ETIMEDOUT|offline/i.test(message);
}

export function isFilesDiskChangedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === FILE_TEXT_WINDOW_CHANGED_CODE
  );
}

/**
 * 探测结果的 UI 动作：
 * - 删除（ENOENT）保留草稿，只提示；
 * - 离线 / 读取失败不当成删除；
 * - 版本相同视为未变化；
 * - 有未保存草稿只提示，干净缓冲才自动重载。
 */
export function resolveFilesDiskProbeOutcome(params: {
  sameVersion: boolean;
  dirty: boolean;
  missing: boolean;
  offline: boolean;
}): "unchanged" | "changed" | "deleted" | "reload" | "skip" {
  if (params.missing) return "deleted";
  if (params.offline) return "skip";
  if (params.sameVersion) return "unchanged";
  return params.dirty ? "changed" : "reload";
}

function isActiveLoadedTextBuffer(
  state: Pick<FilesEditorState, "buffers"> & { layout: FilesEditorLayoutState },
  buffer: FilesBuffer,
): buffer is FilesTextBuffer & { path: string } {
  return (
    isFilesTextBuffer(buffer) &&
    buffer.path !== undefined &&
    !buffer.untitled &&
    buffer.loadState === undefined &&
    buffer.truncated !== true &&
    isFilesEditorBufferActiveInLayout(state.layout, buffer.id)
  );
}

export function collectFilesDiskSyncGroups(
  state: Pick<FilesEditorState, "buffers"> & { layout: FilesEditorLayoutState },
): FilesDiskSyncGroup[] {
  const groups = new Map<string, FilesDiskSyncGroup>();
  for (const buffer of state.buffers) {
    if (!isActiveLoadedTextBuffer(state, buffer)) continue;
    const directory = resolveFilesDiskWatchDirectory(buffer.path);
    const key = `${filesDiskTargetIdentity(buffer)}\u0000${directory}`;
    const group = groups.get(key) ?? {
      key,
      directory,
      workspace: buffer.workspace,
      targets: [],
    };
    group.targets.push({
      id: buffer.id,
      path: buffer.path,
      workspace: buffer.workspace,
      diskVersion: buffer.diskVersion,
      dirty: isFilesBufferDirty(buffer),
    });
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** watcher 只随目录集合变化重建；版本和脏态由事件处理时重新读取。 */
export function filesDiskSyncGroupsKey(groups: readonly FilesDiskSyncGroup[]): string {
  return groups
    .map((group) => group.key)
    .sort()
    .join("\n");
}

function sameDiskTarget(current: FilesBuffer | undefined, target: FilesTextBuffer): boolean {
  return (
    current !== undefined &&
    isFilesTextBuffer(current) &&
    current.id === target.id &&
    current.path === target.path &&
    filesDiskTargetIdentity(current) === filesDiskTargetIdentity(target)
  );
}

export type FilesDiskProbeResult =
  | { kind: "skipped" }
  | { kind: "unchanged" }
  | { kind: "deleted"; observedVersion: null }
  | { kind: "changed"; observedVersion?: string }
  | { kind: "reload"; observedVersion?: string };

export interface FilesDiskProbeFileService {
  readTextFileWindow(args: {
    path: string;
    offset?: number;
    length?: number;
    expectedVersion?: string;
  }): Promise<FileTextWindow>;
}

type ProbeRead =
  | { kind: "window"; window: FileTextWindow }
  | { kind: "missing" }
  | { kind: "changed" }
  | { kind: "offline" }
  | { kind: "failed"; error: unknown };

async function readProbeWindow(
  fileService: FilesDiskProbeFileService,
  path: string,
  expectedVersion?: string,
): Promise<ProbeRead> {
  try {
    const window = await fileService.readTextFileWindow({
      path,
      offset: 0,
      length: 4,
      ...(expectedVersion === undefined ? undefined : { expectedVersion }),
    });
    return { kind: "window", window };
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT") return { kind: "missing" };
    }
    if (isFilesDiskChangedError(error)) return { kind: "changed" };
    if (isFilesDiskOfflineError(error)) return { kind: "offline" };
    return { kind: "failed", error };
  }
}

function markTextChange(
  store: FilesEditorStore,
  id: string,
  change: FilesExternalChange | undefined,
): void {
  store.getState().setTextExternalChange(id, change);
}

/**
 * 对单个文本缓冲做一次版本 probe。调用方负责请求序号与 changeSeq：
 * `isCurrentRequest` 为 false 时所有 result 必须丢弃；`isSaving` 用于抑制
 * 自身保存触发的 watcher 事件。
 */
export async function probeFilesDiskBuffer(options: {
  store: FilesEditorStore;
  bufferId: string;
  fileService: FilesDiskProbeFileService;
  isCurrentRequest: () => boolean;
  isSaving: () => boolean;
}): Promise<FilesDiskProbeResult> {
  const target = findFilesBuffer(options.store.getState(), options.bufferId);
  if (!target || !isFilesTextBuffer(target) || !target.path || target.untitled) {
    return { kind: "skipped" };
  }
  if (options.isSaving()) return { kind: "skipped" };
  if (!isFilesEditorBufferActiveInLayout(options.store.getState().layout, target.id)) {
    return { kind: "skipped" };
  }

  const dirtyAtStart = isFilesBufferDirty(target);
  let read = await readProbeWindow(options.fileService, target.path, target.diskVersion);
  if (read.kind === "changed" && target.diskVersion !== undefined) {
    // expectedVersion 不匹配时再读一次拿到实际版本；删除 / 离线仍按原语义处理。
    read = await readProbeWindow(options.fileService, target.path);
  }

  if (!options.isCurrentRequest() || options.isSaving()) return { kind: "skipped" };
  const current = findFilesBuffer(options.store.getState(), target.id);
  if (!current || !isFilesTextBuffer(current) || !sameDiskTarget(current, target)) {
    return { kind: "skipped" };
  }

  if (read.kind === "missing") {
    markTextChange(options.store, target.id, { kind: "deleted", observedVersion: null });
    return { kind: "deleted", observedVersion: null };
  }
  if (read.kind === "offline") return { kind: "skipped" };
  if (read.kind === "failed") {
    // 权限 / 短暂读取失败保留旧缓冲，只提示不确定的变化，不当作删除。
    markTextChange(options.store, target.id, { kind: "changed" });
    return { kind: "changed" };
  }
  if (read.kind === "changed") {
    const outcome = resolveFilesDiskProbeOutcome({
      sameVersion: false,
      dirty: dirtyAtStart || isFilesBufferDirty(current),
      missing: false,
      offline: false,
    });
    if (outcome === "reload") return { kind: "reload" };
    markTextChange(options.store, target.id, { kind: "changed" });
    return { kind: "changed" };
  }

  const sameVersion =
    current.diskVersion !== undefined && current.diskVersion === read.window.version;
  const outcome = resolveFilesDiskProbeOutcome({
    sameVersion,
    dirty: dirtyAtStart || isFilesBufferDirty(current),
    missing: false,
    offline: false,
  });
  if (outcome === "unchanged" || outcome === "skip") {
    if (current.externalChange) markTextChange(options.store, target.id, undefined);
    return { kind: "unchanged" };
  }
  if (outcome === "deleted") {
    markTextChange(options.store, target.id, { kind: "deleted", observedVersion: null });
    return { kind: "deleted", observedVersion: null };
  }
  if (outcome === "changed") {
    markTextChange(options.store, target.id, {
      kind: "changed",
      observedVersion: read.window.version,
    });
    return { kind: "changed", observedVersion: read.window.version };
  }
  return { kind: "reload", observedVersion: read.window.version };
}
