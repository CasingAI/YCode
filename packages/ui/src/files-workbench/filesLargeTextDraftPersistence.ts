import { logger } from "@/logger.js";
import { FilesLargeTextDraftPersistenceQueue } from "@/files-workbench/filesLargeTextDraftPersistenceQueue.js";
import {
  isFilesLargeTextDraftOwnerOpen,
  readFilesLargeTextDraftForRestore,
} from "@/files-workbench/filesLargeTextDraftRestoreIO.js";
import {
  FilesLargeTextDraftStorageError,
  filesLargeTextDraftBufferIdentity,
  filesLargeTextDraftOwner,
  filesLargeTextDraftStorageKey,
  findFilesDraftBuffer,
  findLargeTextBuffer,
  hasLargeTextDirtyEdit as hasDirtyEdit,
  largeTextBuffers as largeBuffers,
  sameLargeTextDraftIdentity as sameIdentity,
  type FilesDraftBuffer,
  type FilesLargeTextDraftBlockedRecord,
  type FilesLargeTextDraftBlockedReason,
  type FilesLargeTextDraftOwner,
  type FilesLargeTextDraftPersistenceError,
  type FilesLargeTextDraftPersistenceSnapshot,
  type FilesLargeTextDraftRecord,
  type FilesLargeTextDraftProbeResult,
  type FilesLargeTextDraftStorage,
  type FilesLargeTextDraftTrackedBuffer,
} from "@/files-workbench/filesLargeTextDraftStorage.js";
export type {
  FilesLargeTextDraftBlockedReason,
  FilesLargeTextDraftBlockedRecord,
  FilesLargeTextDraftOwner,
  FilesLargeTextDraftPersistenceError,
  FilesLargeTextDraftPersistenceSnapshot,
  FilesLargeTextDraftProbeResult,
} from "@/files-workbench/filesLargeTextDraftStorage.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";
import type { FilesEditorState, FilesLargeTextBuffer } from "@/files-workbench/filesEditorTypes.js";
export interface FilesLargeTextDraftPersistenceOptions {
  store: Pick<FilesEditorStore, "getState" | "subscribe">;
  storage: FilesLargeTextDraftStorage;
  now?: () => number;
  /** 可选：激活时探测磁盘版本；缺省时用 Store 的运行时基准比较。 */
  probeFile?: (buffer: FilesDraftBuffer) => Promise<FilesLargeTextDraftProbeResult>;
  log?: Pick<typeof logger, "warn" | "info">;
}
const EMPTY_SNAPSHOT: FilesLargeTextDraftPersistenceSnapshot = {
  blocked: {},
  errors: {},
  pending: {},
};

export function createFilesLargeTextDraftPersistence(
  options: FilesLargeTextDraftPersistenceOptions,
) {
  const { store, storage } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? logger;
  const tracked = new Map<string, FilesLargeTextDraftTrackedBuffer>();
  const migrations = new Set<Promise<boolean>>();
  const commits = new Set<Promise<boolean>>();
  const coldKeys = new Map<string, string>();
  const blocked = new Map<string, FilesLargeTextDraftBlockedRecord>();
  const errors = new Map<string, FilesLargeTextDraftPersistenceError>();
  const listeners = new Set<() => void>();
  let cachedSnapshot = EMPTY_SNAPSHOT;
  let pending: Readonly<Record<string, boolean>> = {};
  let disposed = false;
  const emit = (): void => {
    cachedSnapshot = {
      blocked: Object.fromEntries(blocked),
      errors: Object.fromEntries(errors),
      pending,
    };
    for (const listener of listeners) listener();
  };
  const queue = new FilesLargeTextDraftPersistenceQueue(
    storage,
    (id, value) => {
      pending = { ...pending, [id]: value };
      emit();
    },
    (id, operation, error) => setError(id, operation, error),
    (id) => errors.delete(id) && emit(),
  );
  const setBlocked = (
    id: string,
    reason: FilesLargeTextDraftBlockedReason,
    record: FilesLargeTextDraftRecord,
    observedVersion?: string | null,
  ): void => {
    blocked.set(id, { bufferId: id, reason, record, observedVersion });
    emit();
  };
  const clearBlocked = (id: string) => blocked.delete(id) && emit();
  const markExternalChange = (
    buffer: FilesLargeTextBuffer,
    change: NonNullable<FilesLargeTextBuffer["externalChange"]>,
  ): void => {
    if (findLargeTextBuffer(store.getState(), buffer.id))
      store.getState().setLargeTextExternalChange(buffer.id, change);
  };
  const setError = (
    bufferId: string,
    operation: FilesLargeTextDraftPersistenceError["operation"],
    error: unknown,
  ): void => {
    const kind = error instanceof FilesLargeTextDraftStorageError ? error.kind : "failed";
    errors.set(bufferId, {
      kind,
      operation,
      message: error instanceof Error ? error.message : String(error),
    });
    log.warn("[files-workbench] 大文件草稿持久化失败", { bufferId, operation, kind, error });
    emit();
  };
  const noteBuffer = (buffer: FilesLargeTextBuffer): FilesLargeTextDraftTrackedBuffer => {
    const identity = filesLargeTextDraftBufferIdentity(buffer),
      existing = tracked.get(buffer.id);
    if (existing?.present && existing.identity === identity) return existing;
    const next = { generation: (existing?.generation ?? 0) + 1, identity, present: true };
    tracked.set(buffer.id, next);
    return next;
  };
  const noteRemoved = (id: string): void => {
    const existing = tracked.get(id);
    if (!existing) return;
    Object.assign(existing, { present: false, restoreKey: undefined });
    existing.generation++;
  };
  function handleState(state: FilesEditorState, previous?: FilesEditorState): void {
    if (disposed) return;
    const current = largeBuffers(state);
    const previousBuffers = previous ? largeBuffers(previous) : new Map();
    const removed = previous
      ? [...previousBuffers.values()].filter((buffer) => !current.has(buffer.id))
      : [];
    const added = previous
      ? [...current.values()].filter((buffer) => !previousBuffers.has(buffer.id))
      : [];
    const renamed = new Set<string>();
    for (const oldBuffer of removed) {
      const target = added.find(
        (candidate) => !renamed.has(candidate.id) && sameIdentity(oldBuffer, candidate),
      );
      if (target) {
        renamed.add(target.id).add(oldBuffer.id);
        void migrateBufferId(oldBuffer.id, target.id);
      }
    }
    for (const oldBuffer of removed) {
      if (renamed.has(oldBuffer.id)) continue;
      noteRemoved(oldBuffer.id);
      if (blocked.has(oldBuffer.id)) {
        clearBlocked(oldBuffer.id);
        queue.clearPending(oldBuffer.id);
        continue;
      }
      // 关闭不保存：只有本会话真正写过的运行时草稿才清除记录。
      if (hasDirtyEdit(oldBuffer.edit)) {
        queue.clearPending(oldBuffer.id);
        queue.enqueueDelete(oldBuffer.id, filesLargeTextDraftBufferIdentity(oldBuffer));
      }
    }
    for (const buffer of current.values()) {
      const state = noteBuffer(buffer);
      const previousEdit = previousBuffers.get(buffer.id)?.edit;
      const edit = buffer.edit;
      const baselineChanged =
        edit !== undefined &&
        previousEdit !== undefined &&
        (previousEdit.baseVersion !== edit.baseVersion ||
          previousEdit.baseTotalBytes !== edit.baseTotalBytes);
      if (baselineChanged) {
        // 保存成功或重新建立基准：旧坐标补丁（含 blocked 记录）立即作废。
        clearBlocked(buffer.id);
        queue.clearPending(buffer.id);
        queue.enqueueDelete(buffer.id, state.identity);
      }
      if (!hasDirtyEdit(edit)) {
        if (hasDirtyEdit(previousEdit) && !baselineChanged && !blocked.has(buffer.id)) {
          // 放弃修改或撤销回原文：记录不再代表有效草稿。
          queue.clearPending(buffer.id);
          queue.enqueueDelete(buffer.id, state.identity);
        }
        continue;
      }
      if (!blocked.has(buffer.id) && edit !== previousEdit) queue.enqueueWrite(buffer, now());
    }
  }
  const sameRestoreTarget = (
    bufferId: string,
    generation: number,
    identity: string,
    revision: number,
  ): FilesLargeTextBuffer | undefined => {
    const state = tracked.get(bufferId);
    if (!state?.present || state.generation !== generation || state.identity !== identity) return;
    const buffer = findLargeTextBuffer(store.getState(), bufferId);
    if (!buffer?.edit || buffer.edit.revision !== revision || buffer.saveToken) return;
    return hasDirtyEdit(buffer.edit) ? undefined : buffer;
  };
  const sameColdTarget = (bufferId: string, identity: string): FilesDraftBuffer | undefined => {
    const buffer = findFilesDraftBuffer(store.getState(), bufferId);
    if (!buffer || buffer.kind === "large-text") return;
    return filesLargeTextDraftBufferIdentity(buffer) === identity ? buffer : undefined;
  };
  function abortRestore(bufferId: string, state: FilesLargeTextDraftTrackedBuffer): void {
    // 保存锁造成的拒绝不是失败，不产生 error / blocked，也不算“已尝试恢复”。
    if (findLargeTextBuffer(store.getState(), bufferId)?.saveToken) state.restoreKey = undefined;
  }
  const restoreOnActivate = async (
    bufferId: string,
    params?: { force?: boolean },
  ): Promise<void> => {
    if (disposed) return;
    const initial = findFilesDraftBuffer(store.getState(), bufferId);
    if (!initial) return;
    if (initial.kind !== "large-text") return inspectColdDraft(initial, params?.force);
    const initialEdit = initial.edit;
    if (!initialEdit || initial.saveToken) return;
    const state = noteBuffer(initial);
    const restoreKey = `${state.generation}:${initialEdit.baseVersion}:${initialEdit.baseTotalBytes}`;
    if (!params?.force && state.restoreKey === restoreKey) return;
    state.restoreKey = restoreKey;
    if (hasDirtyEdit(initialEdit)) return;
    const generation = state.generation;
    const identity = state.identity;
    const revision = initialEdit.revision;
    const stillValid = () => !!sameRestoreTarget(bufferId, generation, identity, revision);
    let result: Awaited<ReturnType<typeof readFilesLargeTextDraftForRestore>>;
    try {
      result = await readFilesLargeTextDraftForRestore({
        storage,
        identity,
        buffer: initial,
        isCurrent: stillValid,
        probeFile: options.probeFile,
        expectedBase: { version: initialEdit.baseVersion, totalBytes: initialEdit.baseTotalBytes },
      });
      if (errors.delete(bufferId)) emit();
    } catch (error) {
      state.restoreKey = undefined;
      setError(bufferId, "load", error);
      return;
    }
    if (result.kind === "empty") return;
    if (result.kind === "stale") return abortRestore(bufferId, state);
    if (result.kind === "blocked") {
      setBlocked(bufferId, result.reason, result.record, result.observedVersion);
      const current = sameRestoreTarget(bufferId, generation, identity, revision);
      if (current && result.deleted) {
        markExternalChange(current, { kind: "deleted", observedVersion: null });
      } else if (current && result.reason === "version-mismatch") {
        markExternalChange(current, {
          kind: "changed",
          observedVersion: result.observedVersion ?? null,
        });
      }
      return;
    }
    const record = result.record;
    // 异步等待期间用户输入或 owner 代次变化时绝不覆盖运行时草稿。
    if (!stillValid()) return abortRestore(bufferId, state);
    const applied = store.getState().restoreLargeTextEdit(bufferId, {
      baseVersion: record.baseVersion,
      baseTotalBytes: record.baseTotalBytes,
      changes: record.changes,
    });
    if (!applied) return;
    clearBlocked(bufferId);
    const current = findLargeTextBuffer(store.getState(), bufferId);
    if (current && !hasDirtyEdit(current.edit)) queue.enqueueDelete(bufferId, state.identity);
  };
  async function inspectColdDraft(buffer: FilesDraftBuffer, force?: boolean): Promise<void> {
    const identity = filesLargeTextDraftBufferIdentity(buffer);
    if (!force && coldKeys.get(buffer.id) === identity) return;
    coldKeys.set(buffer.id, identity);
    let result: Awaited<ReturnType<typeof readFilesLargeTextDraftForRestore>>;
    try {
      result = await readFilesLargeTextDraftForRestore({
        storage,
        identity,
        buffer,
        isCurrent: () => !!sameColdTarget(buffer.id, identity),
        probeFile: options.probeFile,
      });
      if (errors.delete(buffer.id)) emit();
    } catch (error) {
      coldKeys.delete(buffer.id);
      setError(buffer.id, "load", error);
      return;
    }
    if (result.kind === "empty" || result.kind === "stale") return;
    setBlocked(
      buffer.id,
      result.kind === "blocked" ? result.reason : "version-mismatch",
      result.record,
      result.kind === "blocked" ? result.observedVersion : undefined,
    );
  }
  const runMigration = async (oldBufferId: string, newBufferId: string) => {
    if (disposed || oldBufferId === newBufferId) return false;
    await flushQueues();
    try {
      const oldKey = tracked.get(oldBufferId)?.identity;
      if (!oldKey) return false;
      const oldRecord = await storage.load(oldKey);
      if (!oldRecord) return false;
      const targetBuffer = findLargeTextBuffer(store.getState(), newBufferId);
      const owner = targetBuffer ? filesLargeTextDraftOwner(targetBuffer) : undefined;
      const newKey = owner ? filesLargeTextDraftStorageKey(owner) : oldRecord.storageKey;
      if (newKey === oldKey) {
        // 仅 bufferId 改名时 storageKey 不变，直接更新归属，避免把自身记录当成目标冲突。
        await storage.save({ ...oldRecord, bufferId: newBufferId, updatedAt: now() });
        tracked.delete(oldBufferId);
        if (errors.delete(newBufferId)) emit();
        return true;
      }
      const targetRecord = await storage.load(newKey);
      if (targetRecord) {
        // 目标已有草稿（可能是仍在保留的 conflict draft）：保留它，也不删源记录。
        setBlocked(newBufferId, "rename-target-retained", targetRecord);
        return false;
      }
      const migrated: FilesLargeTextDraftRecord = {
        ...oldRecord,
        bufferId: newBufferId,
        storageKey: newKey,
        ...(owner
          ? {
              path: owner.path,
              workspaceKey: owner.workspaceKey,
              remoteSessionId: owner.remoteSessionId,
            }
          : undefined),
        updatedAt: now(),
      };
      await storage.save(migrated);
      await storage.delete(oldKey);
      tracked.delete(oldBufferId);
      if (errors.delete(newBufferId)) emit();
      return true;
    } catch (error) {
      setError(newBufferId, "migrate", error);
      return false;
    }
  };
  function migrateBufferId(oldBufferId: string, newBufferId: string): Promise<boolean> {
    const migration = runMigration(oldBufferId, newBufferId);
    migrations.add(migration);
    void migration.finally(() => migrations.delete(migration));
    return migration;
  }
  const runCommittedDiscard = async (owner: FilesLargeTextDraftOwner): Promise<boolean> => {
    const identity = filesLargeTextDraftStorageKey(owner);
    await flushQueues();
    if (isFilesLargeTextDraftOwnerOpen(store.getState().buffers, identity)) return false;
    if (blocked.get(owner.bufferId)?.record.storageKey === identity) clearBlocked(owner.bufferId);
    if (errors.delete(owner.bufferId)) emit();
    try {
      await storage.delete(identity);
      return true;
    } catch (error) {
      setError(owner.bufferId, "delete", error);
      return false;
    }
  };
  const discardCommittedDraft = (owner: FilesLargeTextDraftOwner): Promise<boolean> => {
    const committed = runCommittedDiscard(owner);
    commits.add(committed);
    void committed.finally(() => commits.delete(committed));
    return committed;
  };
  const flushQueues = () => queue.flush();
  async function flush(): Promise<void> {
    while (queue.hasPending() || migrations.size > 0 || commits.size > 0) {
      await Promise.all([queue.flush(), ...migrations, ...commits]);
    }
  }
  const discardBlockedDraft = async (id: string): Promise<void> => {
    const buffer = findFilesDraftBuffer(store.getState(), id);
    const key =
      blocked.get(id)?.record.storageKey ??
      tracked.get(id)?.identity ??
      (buffer ? filesLargeTextDraftBufferIdentity(buffer) : undefined);
    clearBlocked(id);
    errors.delete(id);
    if (key) queue.enqueueDelete(id, key);
    await flush();
  };
  const unsubscribe = store.subscribe((state, previous) => handleState(state, previous));
  handleState(store.getState());
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => cachedSnapshot,
    restoreOnActivate,
    flush,
    discardBlockedDraft,
    discardCommittedDraft,
    migrateBufferId,
    dispose: () => {
      disposed = true;
      unsubscribe();
    },
  };
}
