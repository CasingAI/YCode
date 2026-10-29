import type { FileTextWindow, FileWatchEvent } from "@zcode/shared";
import type { FilesLargeTextBlockSlice } from "@/files-workbench/filesLargeTextBlockModel.js";
import type { FilesLargeTextNavigationTarget } from "@/files-workbench/filesLargeTextNavigation.js";

export type FilesLargeTextWindowPhase = "idle" | "loading" | "ready" | "error";
export type FilesLargeTextWindowErrorKind =
  | "changed"
  | "deleted"
  | "binary"
  | "offline"
  | "failed";

export interface FilesLargeTextWindowError {
  kind: FilesLargeTextWindowErrorKind;
  code?: string;
  message?: string;
}

export interface FilesLargeTextWindowSnapshot {
  phase: FilesLargeTextWindowPhase;
  /** 当前唯一原始窗口；切窗时整体替换，不累积历史窗口。 */
  window: FileTextWindow | null;
  /**
   * 当前固定块的裁剪结果：实际起止、可编辑性与非法字节判定。
   * 正文以这里为准；`window.content` 只是 raw 窗口，不能直接投影。
   */
  block: FilesLargeTextBlockSlice | null;
  /** 有旧窗口时错误只做提示，不丢弃旧片段。 */
  error: FilesLargeTextWindowError | null;
  /** 磁盘版本已变化但旧窗口仍显示，等待用户刷新。 */
  stale: boolean;
  /** 有界探针看到的新磁盘版本；null 表示文件已删除。 */
  observedVersion?: string | null;
  pendingOffset: number | null;
  /** 每次成功替换窗口 +1，供只读 Monaco 重建有界模型。 */
  revision: number;
}

export interface FilesLargeTextWindowOwner {
  bufferId: string;
  workspaceKey: string;
  remoteSessionId: string;
  path: string;
}

export interface FilesLargeTextWindowReadParams {
  path: string;
  offset: number;
  length: number;
  expectedVersion?: string;
}

export type FilesLargeTextWindowReader = (
  params: FilesLargeTextWindowReadParams,
) => Promise<FileTextWindow>;

/**
 * 文件监视适配器。store 只对每个 buffer entry 启动一次；
 * 返回的函数负责 dispose 订阅、unwatch 并忽略迟到事件。
 */
export type FilesLargeTextWindowWatch = (onChange: (event: FileWatchEvent) => void) => () => void;

export interface FilesLargeTextWindowLease {
  readonly bufferId: string;
  getSnapshot: () => FilesLargeTextWindowSnapshot;
  subscribe: (listener: () => void) => () => void;
  /**
   * 更新 core 决策后的总字节提示（恢复时 acquire 时可能尚不知道）。
   * 元数据不属于窗口身份，不能借此重新 acquire / 释放 seed 的窗口。
   */
  setInitialTotalBytes: (totalBytes: number | undefined) => void;
  /**
   * 编辑草稿基准版本。有脏草稿时导航 / 刷新都必须带它，避免把补丁套到另一版；
   * 保存后由 hook 同步新基准。
   */
  setExpectedVersion: (version: string | undefined) => void;
  /** 可见性变化：首个 active 分屏启动唯一 watcher，最后一个隐藏时停止。 */
  setActive: (active: boolean) => void;
  /** 只有在尚无窗口且用户已进入文件视图时由 hook 调用；隐藏保活不会额外读盘。 */
  ensureLoaded: () => void;
  /**
   * 焦点 / 重新激活时的有界探针：只读 4 字节比较版本，不替换当前窗口、
   * 不重设 edit 基准；发现变化只发布 stale + externalChange 所需信息。
   */
  probeExternalChange: () => void;
  navigate: (target: FilesLargeTextNavigationTarget) => void;
  /** 用户显式刷新：未脏时接受新版本；脏时仍带 baseVersion，冲突只提示。 */
  refresh: () => void;
  retry: () => void;
  release: () => void;
}

const EMPTY_SNAPSHOT: FilesLargeTextWindowSnapshot = {
  phase: "idle",
  window: null,
  block: null,
  error: null,
  stale: false,
  pendingOffset: null,
  revision: 0,
};

export function getEmptyFilesLargeTextWindowSnapshot(): FilesLargeTextWindowSnapshot {
  return EMPTY_SNAPSHOT;
}

export function createIdleFilesLargeTextWindowSnapshot(): FilesLargeTextWindowSnapshot {
  return { ...EMPTY_SNAPSHOT };
}

/**
 * 大文件变化监视使用父目录，而不是直接监视文件本身。
 *
 * 文件监视服务按「监视目录 + 事件文件名」解析 changedPath；直接传文件路径会把
 * 文件名再次拼到文件路径后面，路径过滤永远不命中。另外 `fs.watch` 监视文件时
 * 在原子替换（临时文件 rename 覆盖）后可能仍挂在旧 inode 上，目录 watcher 才能
 * 继续看到目标路径的 rename/create 事件。回调方必须继续按完整文件路径过滤。
 */
export function resolveFilesLargeTextWatchDirectory(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (separator < 0) return path;
  const parent = trimmed.slice(0, separator);
  if (parent === "") return trimmed.slice(0, 1);
  // Windows 盘符根：C: 需要补回分隔符，才能作为可监视目录。
  return /^[a-zA-Z]:$/.test(parent) ? `${parent}\\` : parent;
}

/**
 * 只读窗口 Monaco 模型的 URI。
 *
 * 同一 buffer 的多个分屏共享同一窗口与 revision，但 Monaco 的模型表按 URI
 * 全局唯一；必须把视图实例标识纳入路径，否则第二个分屏 createModel 会抛错。
 * 使用独立 `inmemory://` 命名空间，避免被当成真实工作区文件。
 */
export function filesLargeTextWindowModelUri(params: {
  bufferId: string;
  /** 每个视图实例唯一且稳定的标识（React.useId）；必须是视图级而非 buffer 级。 */
  instanceId: string;
  revision: number;
}): string {
  return `inmemory://files-large-text/${encodeURIComponent(params.bufferId)}/${encodeURIComponent(
    params.instanceId,
  )}/${params.revision}`;
}
