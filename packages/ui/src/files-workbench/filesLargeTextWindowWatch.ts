import { FILE_TEXT_WINDOW_CHANGED_CODE } from "@zcode/shared";
import { isFilesLargeTextWatchEventForPath } from "@/files-workbench/filesLargeTextNavigation.js";
import { isFilesLargeTextDeletedError } from "@/files-workbench/filesLargeTextWindowErrors.js";
import type { FilesLargeTextWindowEntry } from "@/files-workbench/filesLargeTextWindowEntry.js";
import type {
  FilesLargeTextWindowSnapshot,
  FilesLargeTextWindowWatch,
} from "@/files-workbench/filesLargeTextWindowTypes.js";

/**
 * 启动 adapter 并过滤其他路径事件。调用方负责保证同 entry 只启动一次，以及
 * 返回的 stop 在隐藏/释放时执行。
 */
export function startFilesLargeTextWatch(params: {
  watch?: FilesLargeTextWindowWatch;
  path: string;
  isCurrent: () => boolean;
  onFileChange: () => void;
}): (() => void) | undefined {
  if (!params.watch) return undefined;
  try {
    return params.watch((event) => {
      if (!params.isCurrent()) return;
      if (!isFilesLargeTextWatchEventForPath(event, params.path)) return;
      params.onFileChange();
    });
  } catch {
    // 监视失败不影响只读窗口与手动刷新；等待下一次 active 切换再尝试。
    return undefined;
  }
}

/**
 * 焦点 / 重新激活时的有界探针。
 *
 * 只读当前块起点的 4 字节比较版本，不提交新窗口、不触碰 edit 基准。
 * 隐藏期间 watcher 可能漏事件；这里补一次主动检查，发现变化只发布提示。
 */
export function probeFilesLargeTextExternalChange(params: {
  entry: FilesLargeTextWindowEntry;
  isCurrent: () => boolean;
  publish: (snapshot: FilesLargeTextWindowSnapshot) => void;
}): void {
  const { entry, isCurrent, publish } = params;
  const window = entry.snapshot.window;
  if (!window || entry.snapshot.phase === "loading") return;
  const requestSeq = entry.requestSeq;
  if (
    entry.probeInFlight?.window === window &&
    entry.probeInFlight.requestSeq === requestSeq &&
    entry.probeInFlight.probeSeq === entry.probeSeq
  )
    return;
  entry.probeSeq += 1;
  const probeSeq = entry.probeSeq;
  const generation = entry.generation;
  const probe = { window, requestSeq, probeSeq };
  entry.probeInFlight = probe;
  // 保存或重载会替换窗口；旧探测不能反向给新窗口标记删除或变化。
  const stillCurrent = () =>
    isCurrent() &&
    entry.generation === generation &&
    entry.probeSeq === probeSeq &&
    entry.requestSeq === requestSeq &&
    entry.snapshot.window === window;

  void entry
    .readWindow({ path: entry.owner.path, offset: window.offset, length: 4 })
    .then((next) => {
      if (!stillCurrent() || entry.snapshot.phase === "loading") return;
      if (!next.isBinary && next.version === window.version) return;
      publish({
        ...entry.snapshot,
        phase: "ready",
        stale: true,
        observedVersion: next.version,
        error: next.isBinary
          ? { kind: "binary" }
          : { kind: "changed", code: FILE_TEXT_WINDOW_CHANGED_CODE },
        pendingOffset: null,
      });
    })
    .catch((error: unknown) => {
      if (!stillCurrent() || !isFilesLargeTextDeletedError(error)) return;
      publish({
        ...entry.snapshot,
        phase: "ready",
        stale: true,
        observedVersion: null,
        error: { kind: "deleted" },
        pendingOffset: null,
      });
    })
    .finally(() => {
      if (entry.probeInFlight === probe) entry.probeInFlight = undefined;
    });
}

/**
 * 文件变化只提示 stale + changed，不替换正文，也不重置当前版本。
 * 请求进行中收到通知时由调用方递增 changeSeq，迟到结果据此丢弃。
 */
export function markFilesLargeTextExternalChange(
  snapshot: FilesLargeTextWindowSnapshot,
  setSnapshot: (snapshot: FilesLargeTextWindowSnapshot) => void,
): void {
  if (snapshot.window) {
    if (snapshot.stale && snapshot.error?.kind === "changed") return;
    setSnapshot({
      ...snapshot,
      phase: "ready",
      stale: true,
      error: { kind: "changed", code: FILE_TEXT_WINDOW_CHANGED_CODE },
      pendingOffset: null,
    });
    return;
  }
  if (snapshot.phase === "loading") return;
  setSnapshot({
    ...snapshot,
    phase: "error",
    stale: true,
    error: { kind: "changed", code: FILE_TEXT_WINDOW_CHANGED_CODE },
    pendingOffset: null,
  });
}
