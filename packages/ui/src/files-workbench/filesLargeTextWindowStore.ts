import type { FileTextWindow } from "@zcode/shared";
import {
  FILES_LARGE_TEXT_BLOCK_STEP,
  filesLargeTextBlockCount,
  filesLargeTextBlockIndex,
  filesLargeTextNominalBlockStart,
  sliceFilesLargeTextBlockWindow,
} from "@/files-workbench/filesLargeTextBlockModel.js";
import { startFilesLargeTextBlockRequest } from "@/files-workbench/filesLargeTextWindowRequest.js";
import {
  isFilesLargeTextRequestCurrent,
  resolveFilesLargeTextBlockNavigation,
  type FilesLargeTextRequestIdentity,
} from "@/files-workbench/filesLargeTextNavigation.js";
import {
  markFilesLargeTextExternalChange,
  probeFilesLargeTextExternalChange,
  startFilesLargeTextWatch,
} from "@/files-workbench/filesLargeTextWindowWatch.js";
import {
  createIdleFilesLargeTextWindowSnapshot as idleSnapshot,
  type FilesLargeTextWindowLease,
  type FilesLargeTextWindowOwner,
  type FilesLargeTextWindowReader,
  type FilesLargeTextWindowWatch,
} from "@/files-workbench/filesLargeTextWindowTypes.js";
import {
  createFilesLargeTextWindowEntry,
  type FilesLargeTextWindowEntry,
} from "@/files-workbench/filesLargeTextWindowEntry.js";
import {
  filesLargeTextWindowEntries as entries,
  nextFilesLargeTextWindowGeneration,
  notifyFilesLargeTextWindow as notify,
  publishFilesLargeTextWindowSnapshot as setSnapshot,
  sameFilesLargeTextWindowOwner as sameOwner,
} from "@/files-workbench/filesLargeTextWindowContext.js";
import {
  clearFilesLargeTextCoreRetry,
  hasFilesLargeTextCoreRetry,
  retryFilesLargeTextFromCore,
} from "@/files-workbench/filesLargeTextWindowCoreRetry.js";

// 租约类型与空快照仍从 store 导出，调用方无需感知内部控制模块。
export type * from "@/files-workbench/filesLargeTextWindowTypes.js";
export { getEmptyFilesLargeTextWindowSnapshot } from "@/files-workbench/filesLargeTextWindowTypes.js";

/**
 * 每个 buffer 唯一窗口 owner：多 split 共享 entry，单窗替换不累积；
 * 请求序号、版本、迟到结果与监视状态都由这里集中管理。
 */

function requestIdentity(entry: FilesLargeTextWindowEntry): FilesLargeTextRequestIdentity {
  return {
    bufferId: entry.owner.bufferId,
    workspaceKey: entry.owner.workspaceKey,
    remoteSessionId: entry.owner.remoteSessionId,
    path: entry.owner.path,
    generation: entry.generation,
    requestSeq: entry.requestSeq,
  };
}

function isCurrentRequest(
  entry: FilesLargeTextWindowEntry,
  request: FilesLargeTextRequestIdentity,
): boolean {
  return (
    entries.get(entry.owner.bufferId) === entry &&
    isFilesLargeTextRequestCurrent(request, requestIdentity(entry))
  );
}

function startWatch(entry: FilesLargeTextWindowEntry): void {
  if (entry.stopWatch || entry.activeCount <= 0) return;
  const generation = entry.generation;
  entry.stopWatch = startFilesLargeTextWatch({
    watch: entry.watch,
    path: entry.owner.path,
    isCurrent: () => entries.get(entry.owner.bufferId) === entry && entry.generation === generation,
    onFileChange: () => {
      entry.changeSeq += 1;
      markFilesLargeTextExternalChange(entry.snapshot, (snapshot) => setSnapshot(entry, snapshot));
      probeFilesLargeTextExternalChange({
        entry,
        isCurrent: () => entries.get(entry.owner.bufferId) === entry && entry.activeCount > 0,
        publish: (snapshot) => setSnapshot(entry, snapshot),
      });
    },
  });
}

function stopWatch(entry: FilesLargeTextWindowEntry): void {
  entry.probeSeq += 1;
  entry.probeInFlight = undefined;
  const stop = entry.stopWatch;
  entry.stopWatch = undefined;
  stop?.();
}

function startRequest(
  entry: FilesLargeTextWindowEntry,
  blockIndex: number,
  reason: "initial" | "navigate" | "refresh" | "retry",
  options?: { expectedVersion?: string },
): void {
  entry.requestedBlockIndex = blockIndex;
  startFilesLargeTextBlockRequest({
    entry,
    blockIndex,
    reason,
    ...(options === undefined ? {} : { options }),
    isCurrent: (request) => isCurrentRequest(entry, request),
    publish: (snapshot) => setSnapshot(entry, snapshot),
  });
}

function currentTotalBytes(entry: FilesLargeTextWindowEntry): number {
  return entry.snapshot.window?.totalBytes ?? entry.initialTotalBytes ?? 0;
}

function retryFromCore(entry: FilesLargeTextWindowEntry): boolean {
  return retryFilesLargeTextFromCore({
    entry,
    isCurrent: () => entries.get(entry.owner.bufferId) === entry,
    publish: (snapshot) => setSnapshot(entry, snapshot),
  });
}

function currentBlockIndex(entry: FilesLargeTextWindowEntry): number | undefined {
  return (
    entry.snapshot.block?.blockIndex ??
    (entry.snapshot.window ? filesLargeTextBlockIndex(entry.snapshot.window.offset) : undefined) ??
    entry.requestedBlockIndex
  );
}

function requestNavigation(entry: FilesLargeTextWindowEntry, blockIndex: number): void {
  if (!entry.snapshot.window && hasFilesLargeTextCoreRetry(entry) && retryFromCore(entry)) {
    return;
  }
  if (
    entry.snapshot.block?.blockIndex === blockIndex &&
    !entry.snapshot.block.needsExactConfirmation
  ) {
    // 重复点击相邻块或在 EOF 上继续向后不应产生新请求。
    return;
  }
  if (
    entry.snapshot.phase === "loading" &&
    entry.snapshot.pendingOffset === blockIndex * FILES_LARGE_TEXT_BLOCK_STEP
  ) {
    return;
  }
  startRequest(entry, blockIndex, entry.snapshot.window ? "navigate" : "initial");
}

function resetEntry(entry: FilesLargeTextWindowEntry, owner: FilesLargeTextWindowOwner): void {
  stopWatch(entry);
  entry.owner = owner;
  entry.generation += 1;
  entry.requestSeq += 1;
  entry.refCount = 0;
  entry.activeCount = 0;
  entry.changeSeq += 1;
  entry.watch = undefined;
  entry.expectedVersion = undefined;
  entry.requestedBlockIndex = undefined;
  entry.probeSeq = 0;
  entry.snapshot = idleSnapshot();
  clearFilesLargeTextCoreRetry(entry);
  // 旧 owner 的订阅者属于即将卸载的视图；清空后由新视图重新订阅。
  entry.listeners.clear();
}

export function acquireFilesLargeTextWindow(params: {
  owner: FilesLargeTextWindowOwner;
  readWindow: FilesLargeTextWindowReader;
  initialTotalBytes?: number;
  watch?: FilesLargeTextWindowWatch;
}): FilesLargeTextWindowLease {
  const { owner } = params;
  let entry = entries.get(owner.bufferId);
  if (!entry) {
    entry = createFilesLargeTextWindowEntry({
      owner,
      generation: nextFilesLargeTextWindowGeneration(),
      snapshot: idleSnapshot(),
      readWindow: params.readWindow,
      watch: params.watch,
      initialTotalBytes: params.initialTotalBytes,
    });
    entries.set(owner.bufferId, entry);
  } else if (!sameOwner(entry.owner, owner)) {
    // A→B→A 或改名复用同一缓冲 ID：上一代窗口与在途请求全部作废。
    resetEntry(entry, owner);
    entry.readWindow = params.readWindow;
    entry.watch = params.watch;
    entry.initialTotalBytes = params.initialTotalBytes;
    entries.set(owner.bufferId, entry);
  } else {
    entry.readWindow = params.readWindow;
    entry.watch = params.watch;
    // 恢复时首个 acquire 可能还不知道 totalBytes；后续 acquire（另一个分屏或
    // useId 变化）不能把已知提示清空。已加载窗口的 totalBytes 始终优先。
    if (params.initialTotalBytes !== undefined) {
      entry.initialTotalBytes = params.initialTotalBytes;
    }
  }
  entry.refCount += 1;
  const generation = entry.generation;
  let released = false;
  let active = false;
  const isLeaseCurrent = () => !released && entry.generation === generation;

  return {
    bufferId: owner.bufferId,
    getSnapshot: () => entry.snapshot,
    setInitialTotalBytes: (totalBytes) => {
      if (!isLeaseCurrent() || totalBytes === undefined) return;
      entry.initialTotalBytes = totalBytes;
    },
    setExpectedVersion: (version) => {
      if (!isLeaseCurrent()) return;
      entry.expectedVersion = version && version.length > 0 ? version : undefined;
    },
    subscribe: (listener) => {
      if (!isLeaseCurrent()) return () => {};
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    setActive: (nextActive) => {
      if (!isLeaseCurrent() || active === nextActive) return;
      active = nextActive;
      if (nextActive) {
        entry.activeCount += 1;
        startWatch(entry);
      } else {
        entry.activeCount = Math.max(0, entry.activeCount - 1);
        if (entry.activeCount === 0) stopWatch(entry);
      }
    },
    ensureLoaded: () => {
      if (!isLeaseCurrent() || hasFilesLargeTextCoreRetry(entry)) return;
      const block = entry.snapshot.block;
      if (block?.needsExactConfirmation) {
        // seed 只做了窗口裁剪，精确范围复核等 viewer 可见后再读。
        startRequest(entry, block.blockIndex, "retry");
        return;
      }
      if (entry.snapshot.window || entry.snapshot.phase !== "idle") return;
      startRequest(entry, 0, "initial");
    },
    probeExternalChange: () => {
      if (!isLeaseCurrent()) return;
      probeFilesLargeTextExternalChange({
        entry,
        isCurrent: () => entries.get(entry.owner.bufferId) === entry,
        publish: (snapshot) => setSnapshot(entry, snapshot),
      });
    },
    navigate: (target) => {
      if (!isLeaseCurrent()) return;
      const navigation = resolveFilesLargeTextBlockNavigation({
        target,
        currentBlockIndex: currentBlockIndex(entry),
        totalBytes: currentTotalBytes(entry),
      });
      requestNavigation(entry, navigation.blockIndex);
    },
    refresh: () => {
      if (!isLeaseCurrent()) return;
      if (retryFromCore(entry)) return;
      const window = entry.snapshot.window;
      if (!window) {
        if (entry.snapshot.phase !== "loading") startRequest(entry, 0, "initial");
        return;
      }
      // 脏草稿仍带 baseVersion；版本不一致时只提示冲突，不能静默重基线。
      startRequest(entry, currentBlockIndex(entry) ?? 0, "refresh", {
        expectedVersion: entry.expectedVersion,
      });
    },
    retry: () => {
      if (!isLeaseCurrent()) return;
      if (retryFromCore(entry)) return;
      startRequest(
        entry,
        currentBlockIndex(entry) ?? 0,
        entry.snapshot.window ? "retry" : "initial",
        {
          expectedVersion: entry.expectedVersion,
        },
      );
    },
    release: () => {
      if (released) return;
      released = true;
      // 旧 generation 的租约不能递减新 entry 的引用，否则 seed 后旧视图卸载会误删新窗口。
      if (entry.generation !== generation) return;
      if (active) {
        active = false;
        entry.activeCount = Math.max(0, entry.activeCount - 1);
        if (entry.activeCount === 0) stopWatch(entry);
      }
      entry.refCount -= 1;
      if (entry.refCount > 0) return;
      if (entries.get(entry.owner.bufferId) === entry) {
        entries.delete(entry.owner.bufferId);
      }
      stopWatch(entry);
      entry.generation += 1;
      entry.requestSeq += 1;
      entry.listeners.clear();
      entry.watch = undefined;
      entry.snapshot = idleSnapshot();
    },
  };
}

/**
 * 首窗读取/恢复决策完成后注入唯一 entry；正文只属于窗口快照，不进入 buffer。
 * 已有窗口或正在加载时拒绝覆盖；seeded entry 的 refCount 为 0，等首个 viewer acquire。
 */
export function seedFilesLargeTextWindow(
  owner: FilesLargeTextWindowOwner,
  firstWindow: FileTextWindow,
): boolean {
  if (firstWindow.isBinary || firstWindow.path !== owner.path) return false;
  let entry = entries.get(owner.bufferId);
  if (!entry) {
    entry = createFilesLargeTextWindowEntry({
      owner,
      generation: nextFilesLargeTextWindowGeneration(),
      snapshot: idleSnapshot(),
      readWindow: async () => {
        throw new Error("files-large-text-reader-not-bound");
      },
      initialTotalBytes: firstWindow.totalBytes,
    });
    entries.set(owner.bufferId, entry);
  } else {
    if (!sameOwner(entry.owner, owner)) {
      resetEntry(entry, owner);
      entry.readWindow = async () => {
        throw new Error("files-large-text-reader-not-bound");
      };
      entry.initialTotalBytes = firstWindow.totalBytes;
    } else if (
      !hasFilesLargeTextCoreRetry(entry) &&
      (entry.snapshot.window || entry.snapshot.phase === "loading")
    ) {
      // core loader 发起的重试允许用新首窗替换旧窗口 / loading；
      // 普通 seed 仍不能覆盖已在读取或已显示的 viewer 窗口。
      return false;
    }
  }
  // seed 成功即完成首次决策，后续刷新不再需要绕回 core loader。
  clearFilesLargeTextCoreRetry(entry);
  // seed 的 totalBytes 是核心决策的权威结果，同时补齐 acquire 时未知的提示。
  entry.initialTotalBytes = firstWindow.totalBytes;
  const blockIndex = filesLargeTextBlockIndex(firstWindow.offset);
  setSnapshot(entry, {
    phase: "ready",
    window: firstWindow,
    block: sliceFilesLargeTextBlockWindow({
      blockIndex,
      totalBytes: firstWindow.totalBytes,
      window: firstWindow,
    }),
    error: null,
    stale: false,
    pendingOffset: null,
    revision: entry.snapshot.revision + 1,
  });
  // dispose 停掉的 watcher 在重新 seed 后恢复；隐藏视图（activeCount=0）等
  // setActive 再启动，避免隐藏保活额外监听。
  startWatch(entry);
  return true;
}

/**
 * 保存成功后按新版本重载当前块。
 *
 * 不复用旧窗口的实际 offset：前块增删后，新版本的规范块起点可能与旧窗口不同，
 * 统一交给块 loader 重新做边界探查与精确复核。旧窗口和保存前更早发出的读取
 * 立即通过请求序号失效；读取失败时 entry 不保留旧版本窗口，重试只带新基准。
 * SaveAs 等 owner 变化由调用方清理旧 entry，旧 lease 的同代窗口不得展示新路径。
 */
export function reloadFilesLargeTextWindowAfterSave(params: {
  owner: FilesLargeTextWindowOwner;
  totalBytes: number;
  version: string;
}): boolean {
  const entry = entries.get(params.owner.bufferId);
  if (!entry) return false;
  if (!sameOwner(entry.owner, params.owner) || entry.refCount <= 0) {
    // 无可见 lease 时下一次 acquire 会按新版本首次加载；owner 不同则先销毁旧路径窗口。
    disposeFilesLargeTextWindow(params.owner.bufferId);
    return false;
  }
  const totalBytes = Math.max(0, params.totalBytes);
  const blockIndex = Math.min(
    Math.max(0, currentBlockIndex(entry) ?? 0),
    filesLargeTextBlockCount(totalBytes) - 1,
  );
  entry.initialTotalBytes = totalBytes;
  // 重试 / 刷新必须绑定保存后的新版本，不能继续钉住旧 baseVersion。
  entry.expectedVersion = params.version;
  // 先清空旧窗口再走统一 loader：读取失败应发布新版本的可重试错误态，
  // 而不是让旧版本窗口继续显示或参与编辑坐标。
  setSnapshot(entry, {
    phase: "loading",
    window: null,
    block: null,
    error: null,
    stale: false,
    pendingOffset: filesLargeTextNominalBlockStart(blockIndex),
    revision: entry.snapshot.revision + 1,
  });
  startRequest(entry, blockIndex, "refresh", { expectedVersion: params.version });
  return true;
}

/**
 * 关闭缓冲、转为可编辑/预览或工作区身份变化时显式失效。
 * 传入 owner 可避免旧代清理误删刚 seed 的同 ID entry。
 */
export function disposeFilesLargeTextWindow(
  bufferId: string,
  owner?: FilesLargeTextWindowOwner,
): void {
  const entry = entries.get(bufferId);
  if (!entry || (owner && !sameOwner(entry.owner, owner))) return;
  clearFilesLargeTextCoreRetry(entry);
  stopWatch(entry);
  // 失效在途请求与外部变化序号；保留 generation 让仍挂载的 lease 继续有效。
  entry.requestSeq += 1;
  entry.changeSeq += 1;
  entry.requestedBlockIndex = undefined;
  entry.snapshot = idleSnapshot();
  if (entry.refCount > 0) {
    // core 在同一 owner 上 dispose 后可能重新 seed（例如冲突重载）。若此时直接删除
    // entry，旧 lease 的 getSnapshot 会永久停在 idle，且重新 acquire 会在
    // refCount 归零时删掉刚 seed 的窗口，导致首窗重读。保留 entry 与订阅，等 seed
    // 直接交付新窗口；最后一个 lease release 时再删除。
    notify(entry);
    return;
  }
  entries.delete(bufferId);
  entry.generation += 1;
  entry.listeners.clear();
  entry.watch = undefined;
}
