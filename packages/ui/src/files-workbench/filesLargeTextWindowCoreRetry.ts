import { toFilesLargeTextReadError } from "@/files-workbench/filesLargeTextWindowErrors.js";
import type { FilesLargeTextWindowEntry } from "@/files-workbench/filesLargeTextWindowEntry.js";
import type { FilesLargeTextWindowSnapshot } from "@/files-workbench/filesLargeTextWindowTypes.js";

type FilesLargeTextCoreRetry = () => void | Promise<void>;

/**
 * core 首次决策失败后注入的统一 loader。viewer 的 retry / refresh 优先走它，
 * 避免直接按窗口读取而绕过大小、二进制、编码的重新决策。
 */
const coreRetries = new WeakMap<FilesLargeTextWindowEntry, FilesLargeTextCoreRetry>();

export function hasFilesLargeTextCoreRetry(entry: FilesLargeTextWindowEntry): boolean {
  return coreRetries.has(entry);
}

export function clearFilesLargeTextCoreRetry(entry: FilesLargeTextWindowEntry): void {
  coreRetries.delete(entry);
}

/** 通知 viewer 该 owner 首次决策失败；entry 尚不存在时由 store 负责建立。 */
export function applyFilesLargeTextFailure(params: {
  entry: FilesLargeTextWindowEntry;
  error: unknown;
  retry: FilesLargeTextCoreRetry;
  publish: (snapshot: FilesLargeTextWindowSnapshot) => void;
}): void {
  const { entry, error, retry, publish } = params;
  coreRetries.set(entry, retry);
  publish({
    ...entry.snapshot,
    phase: entry.snapshot.window ? "ready" : "error",
    error: toFilesLargeTextReadError(error),
    stale: entry.snapshot.window ? entry.snapshot.stale : false,
    pendingOffset: null,
  });
}

/** 由 viewer 的 retry / refresh / 无窗口导航触发统一 core loader。 */
export function retryFilesLargeTextFromCore(params: {
  entry: FilesLargeTextWindowEntry;
  isCurrent: () => boolean;
  publish: (snapshot: FilesLargeTextWindowSnapshot) => void;
}): boolean {
  const { entry, isCurrent, publish } = params;
  const retry = coreRetries.get(entry);
  if (!retry) return false;
  const generation = entry.generation;
  const stillCurrent = () => entry.generation === generation && isCurrent();
  entry.requestSeq += 1;
  publish({
    ...entry.snapshot,
    phase: entry.snapshot.window ? "ready" : "loading",
    error: null,
    stale: false,
    pendingOffset: null,
  });
  void Promise.resolve()
    .then(retry)
    .then(() => {
      if (!stillCurrent() || entry.snapshot.phase !== "loading" || entry.snapshot.window) return;
      // 统一 loader 正常会 seed 或转成其他缓冲；没有交付窗口时恢复为可重试错误态。
      publish({
        ...entry.snapshot,
        phase: "error",
        error: { kind: "failed", message: "files-large-text-retry-incomplete" },
        pendingOffset: null,
      });
    })
    .catch((error: unknown) => {
      if (!stillCurrent()) return;
      publish({
        ...entry.snapshot,
        phase: entry.snapshot.window ? "ready" : "error",
        error: toFilesLargeTextReadError(error),
        pendingOffset: null,
      });
    });
  return true;
}
