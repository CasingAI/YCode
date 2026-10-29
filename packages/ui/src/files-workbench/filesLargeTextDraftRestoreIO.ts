import type { FilesEditorState } from "@/files-workbench/filesEditorTypes.js";
import {
  filesLargeTextDraftOwner,
  filesLargeTextDraftStorageKey,
  type FilesDraftBuffer,
  type FilesLargeTextDraftBlockedReason,
  type FilesLargeTextDraftProbeResult,
  type FilesLargeTextDraftRecord,
  type FilesLargeTextDraftStorage,
} from "@/files-workbench/filesLargeTextDraftStorage.js";

export function isFilesLargeTextDraftOwnerOpen(
  buffers: readonly FilesEditorState["buffers"][number][],
  identity: string,
): boolean {
  return buffers.some(
    (buffer) =>
      buffer.path !== undefined &&
      filesLargeTextDraftStorageKey(
        filesLargeTextDraftOwner({ id: buffer.id, path: buffer.path, workspace: buffer.workspace }),
      ) === identity,
  );
}

export type FilesLargeTextDraftRestoreReadResult =
  | { kind: "empty" }
  | { kind: "stale" }
  | {
      kind: "blocked";
      record: FilesLargeTextDraftRecord;
      reason: FilesLargeTextDraftBlockedReason;
      observedVersion?: string | null;
      deleted?: true;
    }
  | { kind: "ready"; record: FilesLargeTextDraftRecord };

/** 无 controller 状态的读取与恢复资格检查；状态结果由唯一 persistence controller 持有。 */
export async function readFilesLargeTextDraftForRestore(params: {
  storage: FilesLargeTextDraftStorage;
  identity: string;
  buffer: FilesDraftBuffer;
  isCurrent: () => boolean;
  probeFile?: (buffer: FilesDraftBuffer) => Promise<FilesLargeTextDraftProbeResult>;
  expectedBase?: { version: string; totalBytes: number };
}): Promise<FilesLargeTextDraftRestoreReadResult> {
  const record = await params.storage.load(params.identity);
  if (!record) return { kind: "empty" };
  if (!params.isCurrent()) return { kind: "stale" };

  const owner = filesLargeTextDraftOwner(params.buffer);
  if (
    record.storageKey !== params.identity ||
    record.path !== params.buffer.path ||
    record.workspaceKey !== owner.workspaceKey ||
    record.remoteSessionId !== owner.remoteSessionId
  ) {
    return { kind: "blocked", reason: "identity-mismatch", record };
  }
  if (params.probeFile) {
    let probe: FilesLargeTextDraftProbeResult;
    try {
      probe = await params.probeFile(params.buffer);
    } catch {
      return { kind: "blocked", reason: "probe-failed", record };
    }
    if (!params.isCurrent()) return { kind: "stale" };
    if (probe.kind === "missing") {
      return { kind: "blocked", reason: "missing", observedVersion: null, deleted: true, record };
    }
    if (probe.kind !== "present") {
      return {
        kind: "blocked",
        reason: probe.kind === "binary" ? "binary" : "probe-failed",
        record,
      };
    }
    if (probe.version !== record.baseVersion || probe.totalBytes !== record.baseTotalBytes) {
      return {
        kind: "blocked",
        reason: "version-mismatch",
        observedVersion: probe.version,
        record,
      };
    }
  } else if (
    params.expectedBase &&
    (params.expectedBase.version !== record.baseVersion ||
      params.expectedBase.totalBytes !== record.baseTotalBytes)
  ) {
    return {
      kind: "blocked",
      reason: "version-mismatch",
      observedVersion: params.expectedBase.version,
      record,
    };
  }
  return { kind: "ready", record };
}
