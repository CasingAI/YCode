import { FILE_TEXT_WINDOW_CHANGED_CODE } from "@zcode/shared";
import type { FileTextWindow } from "@zcode/shared";
import {
  filesLargeTextBlockCount,
  filesLargeTextBlockReadRequest,
  filesLargeTextCodePointByteLengthAtStart,
  filesLargeTextExactBlockReadRequest,
  filesLargeTextNominalBlockEnd,
  sliceFilesLargeTextBlockWindow,
  type FilesLargeTextBlockSlice,
} from "@/files-workbench/filesLargeTextBlockModel.js";
import {
  resolveFilesLargeTextExpectedVersion,
  type FilesLargeTextRequestIdentity,
} from "@/files-workbench/filesLargeTextNavigation.js";
import { toFilesLargeTextReadError } from "@/files-workbench/filesLargeTextWindowErrors.js";
import type { FilesLargeTextWindowEntry } from "@/files-workbench/filesLargeTextWindowEntry.js";
import type { FilesLargeTextWindowSnapshot } from "@/files-workbench/filesLargeTextWindowTypes.js";

export type FilesLargeTextRequestReason = "initial" | "navigate" | "refresh" | "retry";

function settleChanged(
  entry: FilesLargeTextWindowEntry,
  publish: (snapshot: FilesLargeTextWindowSnapshot) => void,
): void {
  publish({
    ...entry.snapshot,
    phase: entry.snapshot.window ? "ready" : "error",
    error: { kind: "changed", code: FILE_TEXT_WINDOW_CHANGED_CODE },
    stale: true,
    pendingOffset: null,
  });
}

/**
 * 提交固定块结果。`window` 保留原始读取信息（版本 / 总大小），正文统一走
 * `block`，避免 Viewer 直接投影未对齐的 raw content。
 */
function commitBlock(
  entry: FilesLargeTextWindowEntry,
  window: FileTextWindow,
  block: FilesLargeTextBlockSlice,
  changedDuringRequest: boolean,
  publish: (snapshot: FilesLargeTextWindowSnapshot) => void,
): void {
  if (changedDuringRequest && entry.snapshot.window) {
    // 文件在读取期间变化：旧窗口保留，只提示刷新，不能自动换成结果。
    settleChanged(entry, publish);
    return;
  }
  publish({
    phase: "ready",
    window,
    block: { ...block, needsExactConfirmation: false },
    error: changedDuringRequest
      ? { kind: "changed", code: FILE_TEXT_WINDOW_CHANGED_CODE }
      : null,
    stale: changedDuringRequest,
    pendingOffset: null,
    revision: entry.snapshot.revision + 1,
  });
}

/**
 * 精确复核失败（probe 或 exact read）：已有旧块时只提示，不覆盖已显示内容。
 */
function settleFollowupFailure(
  entry: FilesLargeTextWindowEntry,
  publish: (snapshot: FilesLargeTextWindowSnapshot) => void,
  error: unknown,
): void {
  const readError = toFilesLargeTextReadError(error);
  if (entry.snapshot.window) {
    publish({
      ...entry.snapshot,
      phase: "ready",
      error: readError,
      stale: readError.kind === "changed" ? true : entry.snapshot.stale,
      pendingOffset: null,
    });
    return;
  }
  publish({
    ...entry.snapshot,
    phase: "error",
    error: readError,
    stale: readError.kind === "changed" ? true : entry.snapshot.stale,
    pendingOffset: null,
  });
}

/**
 * 把 `nominalEnd` 的最小窗口 probe 解释为块的**真实**结束位置。
 *
 * 服务只在请求偏移位于合法多字节码点内部时才向前回退，因此
 * `probe.offset < nominalEnd` 是「名义边界在合法码点内部」的唯一证据；
 * 非法 continuation 串保持请求偏移，结束位置就是 nominalEnd。
 * probe 返回内容的首码点必然是合法码点，其字节长度可以精确计算。
 * 绝不把含替换字符的窗口重新编码来反推原文件字节坐标。
 */
function resolveProbedBlockEnd(params: {
  nominalEnd: number;
  blockStart: number;
  totalBytes: number;
  probe: FileTextWindow;
}): number {
  const totalBytes = Math.max(0, params.totalBytes);
  const nominalEnd = Math.min(Math.max(0, params.nominalEnd), totalBytes);
  const servedOffset = params.probe.offset;
  if (!Number.isFinite(servedOffset) || servedOffset >= nominalEnd) return nominalEnd;
  const firstCodePointBytes = filesLargeTextCodePointByteLengthAtStart(params.probe.content);
  if (firstCodePointBytes <= 0) return nominalEnd;
  return Math.min(
    totalBytes,
    Math.max(params.blockStart, Math.floor(servedOffset) + firstCodePointBytes),
  );
}

/**
 * 读取一个固定块：先按名义起点读 256 KiB，交给核心 slice 对齐。
 *
 * 初次窗口含非法字节时，名义结束位置可能落在另一个合法多字节码点内部；
 * 先用 length=4 的 probe 得到真实结束位置，再用 `[actualStart, actualEnd)`
 * 精确重读确认解码错误归属。probe 与精确读取都必须钉住首窗版本，避免混版。
 */
export function startFilesLargeTextBlockRequest(params: {
  entry: FilesLargeTextWindowEntry;
  blockIndex: number;
  reason: FilesLargeTextRequestReason;
  options?: { expectedVersion?: string; allowShrinkClamp?: boolean };
  isCurrent: (request: FilesLargeTextRequestIdentity) => boolean;
  publish: (snapshot: FilesLargeTextWindowSnapshot) => void;
}): void {
  const { entry, blockIndex, reason, options, isCurrent, publish } = params;
  const request: FilesLargeTextRequestIdentity = {
    bufferId: entry.owner.bufferId,
    workspaceKey: entry.owner.workspaceKey,
    remoteSessionId: entry.owner.remoteSessionId,
    path: entry.owner.path,
    generation: entry.generation,
    requestSeq: entry.requestSeq + 1,
  };
  entry.requestSeq = request.requestSeq;
  const changeSeqAtStart = entry.changeSeq;
  const expectedVersion =
    options?.expectedVersion ??
    entry.expectedVersion ??
    resolveFilesLargeTextExpectedVersion({
      reason,
      currentVersion: entry.snapshot.window?.version,
    });
  const readWindow = entry.readWindow;
  const totalBytes = entry.snapshot.window?.totalBytes ?? entry.initialTotalBytes ?? 0;
  const requestTotalBytes = totalBytes > 0 ? totalBytes : Number.MAX_SAFE_INTEGER;
  const readRequest = filesLargeTextBlockReadRequest({
    blockIndex,
    totalBytes: requestTotalBytes,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  });
  publish({
    ...entry.snapshot,
    phase: "loading",
    error: null,
    pendingOffset: readRequest.offset,
  });

  void readWindow({
    path: entry.owner.path,
    offset: readRequest.offset,
    length: readRequest.length,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  })
    .then((window) => {
      if (!isCurrent(request)) return;
      if (expectedVersion !== undefined && window.version !== expectedVersion) {
        settleChanged(entry, publish);
        return;
      }
      if (window.isBinary) {
        // 文件在窗口间变成二进制：保留旧片段并明确提示，不能显示空文本窗。
        publish({
          ...entry.snapshot,
          phase: entry.snapshot.window ? "ready" : "error",
          error: { kind: "binary" },
          pendingOffset: null,
        });
        return;
      }
      // 刷新时文件缩短会让旧块索引越界；自动夹紧到最后一块一次。
      const lastBlockIndex = filesLargeTextBlockCount(window.totalBytes) - 1;
      if (
        reason === "refresh" &&
        options?.allowShrinkClamp !== false &&
        blockIndex > lastBlockIndex
      ) {
        startFilesLargeTextBlockRequest({
          entry,
          blockIndex: lastBlockIndex,
          reason: "refresh",
          options: { expectedVersion, allowShrinkClamp: false },
          isCurrent,
          publish,
        });
        return;
      }
      const block = sliceFilesLargeTextBlockWindow({
        blockIndex,
        totalBytes: window.totalBytes,
        window,
        probeShortWindow: true,
      });
      if (!block.needsExactConfirmation) {
        commitBlock(entry, window, block, entry.changeSeq !== changeSeqAtStart, publish);
        return;
      }
      // 初次窗口无法确定真实结束位置（含非法字节，或被服务尾部回退截短）：
      // 后续 probe / 精确读取钉住首窗版本，即使初始请求没有 expectedVersion
      // 也不能读到另一版文件。
      const pinnedVersion = window.version;
      const nominalEnd = filesLargeTextNominalBlockEnd(blockIndex);
      void readWindow({
        path: entry.owner.path,
        offset: nominalEnd,
        length: 4,
        expectedVersion: pinnedVersion,
      })
        .then((probe) => {
          if (!isCurrent(request)) return;
          if (probe.version !== pinnedVersion) {
            settleChanged(entry, publish);
            return;
          }
          if (probe.isBinary) {
            publish({
              ...entry.snapshot,
              phase: entry.snapshot.window ? "ready" : "error",
              error: { kind: "binary" },
              pendingOffset: null,
            });
            return;
          }
          const actualEnd = resolveProbedBlockEnd({
            nominalEnd,
            blockStart: block.offset,
            totalBytes: window.totalBytes,
            probe,
          });
          // 初次窗口的非法字节可能只属于越界尾部；用严格本块范围复核。
          const exactRequest = filesLargeTextExactBlockReadRequest({
            slice: { offset: block.offset, nextOffset: actualEnd },
            totalBytes: window.totalBytes,
            expectedVersion: pinnedVersion,
          });
          return readWindow({
            path: entry.owner.path,
            offset: exactRequest.offset,
            length: exactRequest.length,
            expectedVersion: pinnedVersion,
          }).then((exactWindow) => {
            if (!isCurrent(request)) return;
            if (exactWindow.version !== pinnedVersion) {
              settleChanged(entry, publish);
              return;
            }
            if (exactWindow.isBinary) {
              publish({
                ...entry.snapshot,
                phase: entry.snapshot.window ? "ready" : "error",
                error: { kind: "binary" },
                pendingOffset: null,
              });
              return;
            }
            const confirmed = sliceFilesLargeTextBlockWindow({
              blockIndex,
              totalBytes: exactWindow.totalBytes,
              window: exactWindow,
              knownStart: block.offset,
              knownEnd: actualEnd,
              exact: true,
            });
            commitBlock(
              entry,
              exactWindow,
              { ...confirmed, needsExactConfirmation: false },
              entry.changeSeq !== changeSeqAtStart,
              publish,
            );
          });
        })
        .catch((error: unknown) => {
          if (!isCurrent(request)) return;
          settleFollowupFailure(entry, publish, error);
        });
    })
    .catch((error: unknown) => {
      if (!isCurrent(request)) return;
      const readError = toFilesLargeTextReadError(error);
      publish({
        ...entry.snapshot,
        phase: entry.snapshot.window ? "ready" : "error",
        error: readError,
        stale: readError.kind === "changed" ? true : entry.snapshot.stale,
        pendingOffset: null,
      });
    });
}
