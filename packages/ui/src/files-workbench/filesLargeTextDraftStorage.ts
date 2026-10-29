import { filesWorkspaceKey } from "@/files-workbench/filesEditorBufferModel.js";
import {
  hasFilesLargeTextEditChanges,
  isFilesLargeTextChangeEffective,
} from "@/files-workbench/filesLargeTextDraftModel.js";
import type {
  FilesEditorState,
  FilesLargeTextBlockChange,
  FilesLargeTextBuffer,
  FilesLargeTextEditState,
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";

/**
 * 大文件块补丁草稿的 IndexedDB 适配器。
 *
 * 这里只负责异步持久化与记录结构校验；运行时事实仍在 Files Editor Store。
 * 不保存全文、未修改块、当前窗口或撤销 / 重做历史。
 */

export const FILES_LARGE_TEXT_DRAFT_SCHEMA_VERSION = 1;
export const FILES_LARGE_TEXT_DRAFT_DB_NAME = "zcode-files-large-text-drafts";
export const FILES_LARGE_TEXT_DRAFT_STORE_NAME = "drafts";
/** v2 起主键改为包含 workspace / remoteSession / path 的 storageKey。 */
export const FILES_LARGE_TEXT_DRAFT_DB_VERSION = 2;

export interface FilesLargeTextDraftRecord {
  schemaVersion: typeof FILES_LARGE_TEXT_DRAFT_SCHEMA_VERSION;
  bufferId: string;
  path: string;
  /** workspaceKey + remoteSessionId + path；IndexedDB 主键，避免跨 owner 碰撞。 */
  storageKey: string;
  /** `workspaceIdentity?.trim() || workspacePath`。 */
  workspaceKey: string;
  /** 远端工作区会话标识；本地为空串。 */
  remoteSessionId: string;
  baseVersion: string;
  baseTotalBytes: number;
  changes: FilesLargeTextBlockChange[];
  updatedAt: number;
}

export type FilesLargeTextDraftStorageErrorKind = "unavailable" | "quota" | "failed";

export class FilesLargeTextDraftStorageError extends Error {
  readonly kind: FilesLargeTextDraftStorageErrorKind;

  constructor(kind: FilesLargeTextDraftStorageErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FilesLargeTextDraftStorageError";
    this.kind = kind;
  }
}

/** 可被测试 fake 实现；持久化控制器只依赖该接口。 */
export interface FilesLargeTextDraftStorage {
  load(storageKey: string): Promise<FilesLargeTextDraftRecord | undefined>;
  save(record: FilesLargeTextDraftRecord): Promise<void>;
  delete(storageKey: string): Promise<void>;
}

/** 恢复被拒绝时保留记录的原因；UI 只能提示，不能据此改基准。 */
export type FilesLargeTextDraftBlockedReason =
  | "version-mismatch"
  | "missing"
  | "binary"
  | "identity-mismatch"
  | "probe-failed"
  | "rename-target-retained";

export interface FilesLargeTextDraftBlockedRecord {
  bufferId: string;
  reason: FilesLargeTextDraftBlockedReason;
  record: FilesLargeTextDraftRecord;
  observedVersion?: string | null;
}

export interface FilesLargeTextDraftPersistenceError {
  kind: FilesLargeTextDraftStorageErrorKind;
  operation: "load" | "save" | "delete" | "migrate";
  message: string;
}

export interface FilesLargeTextDraftPersistenceSnapshot {
  blocked: Readonly<Record<string, FilesLargeTextDraftBlockedRecord>>;
  errors: Readonly<Record<string, FilesLargeTextDraftPersistenceError>>;
  pending: Readonly<Record<string, boolean>>;
}

/** 串行写入队列与 buffer 代次跟踪的共享形状。 */
export interface FilesLargeTextDraftTrackedBuffer {
  generation: number;
  identity: string;
  present: boolean;
  restoreKey?: string;
  lastQueuedEdit?: FilesLargeTextEditState;
}
export type FilesLargeTextDraftOperation =
  | { kind: "write"; record: FilesLargeTextDraftRecord; edit: FilesLargeTextEditState }
  | { kind: "delete"; storageKey: string };
export interface FilesLargeTextDraftQueue {
  pending?: FilesLargeTextDraftOperation;
  running: boolean;
  tail: Promise<void>;
}

export type FilesLargeTextDraftProbeResult =
  | { kind: "present"; version: string; totalBytes: number }
  | { kind: "missing" }
  | { kind: "binary" }
  | { kind: "failed" };

/** 带磁盘路径的任意文件缓冲；cold draft 检查不只针对 large-text。 */
export type FilesDraftBuffer = FilesEditorState["buffers"][number] & { path: string };

/** 明确的草稿 owner，用于 SaveAs 后按旧路径精确清理，不能只靠 bufferId。 */
export interface FilesLargeTextDraftOwner {
  bufferId: string;
  workspaceKey: string;
  remoteSessionId: string;
  path: string;
}

/** 记录隔离身份：workspace identity + remote session + path。 */
export function filesLargeTextDraftStorageKey(owner: {
  workspaceKey: string;
  remoteSessionId: string;
  path: string;
}): string {
  return [owner.workspaceKey, owner.remoteSessionId, owner.path].join("\u0000");
}
export function filesLargeTextDraftOwner(
  buffer: { id: string; path: string; workspace: FilesWorkspaceRef },
  path = buffer.path,
): FilesLargeTextDraftOwner {
  return {
    bufferId: buffer.id,
    workspaceKey: filesWorkspaceKey(buffer.workspace),
    remoteSessionId: buffer.workspace.workspaceRemoteSessionId?.trim() ?? "",
    path,
  };
}
export function filesLargeTextDraftBufferIdentity(buffer: {
  path: string;
  workspace: FilesWorkspaceRef;
}): string {
  return filesLargeTextDraftStorageKey({
    workspaceKey: filesWorkspaceKey(buffer.workspace),
    remoteSessionId: buffer.workspace.workspaceRemoteSessionId?.trim() ?? "",
    path: buffer.path,
  });
}
export function filesLargeTextDraftRecordStorageKey(
  record: Pick<FilesLargeTextDraftRecord, "workspaceKey" | "remoteSessionId" | "path">,
): string {
  return filesLargeTextDraftStorageKey(record);
}

export function isLargeTextBuffer(
  buffer: FilesEditorState["buffers"][number],
): buffer is FilesLargeTextBuffer {
  return buffer.kind === "large-text";
}
export function largeTextBuffers(state: FilesEditorState): Map<string, FilesLargeTextBuffer> {
  return new Map(state.buffers.filter(isLargeTextBuffer).map((buffer) => [buffer.id, buffer]));
}
export function findLargeTextBuffer(
  state: FilesEditorState,
  id: string,
): FilesLargeTextBuffer | undefined {
  const buffer = state.buffers.find((candidate) => candidate.id === id);
  return buffer && isLargeTextBuffer(buffer) ? buffer : undefined;
}
export function findFilesDraftBuffer(
  state: FilesEditorState,
  id: string,
): FilesDraftBuffer | undefined {
  const buffer = state.buffers.find((candidate) => candidate.id === id);
  return buffer?.path ? (buffer as FilesDraftBuffer) : undefined;
}
export function largeTextRemoteSessionId(buffer: FilesLargeTextBuffer): string {
  return buffer.workspace.workspaceRemoteSessionId?.trim() ?? "";
}
export function hasLargeTextDirtyEdit(edit: FilesLargeTextEditState | undefined): boolean {
  return hasFilesLargeTextEditChanges(edit);
}
export function sameLargeTextDraftIdentity(
  left: FilesLargeTextBuffer,
  right: FilesLargeTextBuffer,
): boolean {
  return filesLargeTextDraftBufferIdentity(left) === filesLargeTextDraftBufferIdentity(right);
}

/** 只构造持久化字段；undostack、全文与未修改块永远不会进入记录。 */
export function createFilesLargeTextDraftRecord(
  buffer: FilesLargeTextBuffer,
  edit: FilesLargeTextEditState,
  updatedAt: number,
): FilesLargeTextDraftRecord | undefined {
  const changes = edit.changes
    .filter(isFilesLargeTextChangeEffective)
    .map((change) => ({ ...change }));
  if (!buffer.path || !edit.baseVersion || changes.length === 0) return undefined;
  const workspaceKey = filesWorkspaceKey(buffer.workspace);
  const remoteSessionId = buffer.workspace.workspaceRemoteSessionId?.trim() ?? "";
  return {
    schemaVersion: FILES_LARGE_TEXT_DRAFT_SCHEMA_VERSION,
    bufferId: buffer.id,
    path: buffer.path,
    storageKey: filesLargeTextDraftStorageKey({ workspaceKey, remoteSessionId, path: buffer.path }),
    workspaceKey,
    remoteSessionId,
    baseVersion: edit.baseVersion,
    baseTotalBytes: edit.baseTotalBytes,
    changes,
    updatedAt,
  };
}

interface IndexedDbDraftStorageOptions {
  /** 显式传入 null 可模拟无 IndexedDB 环境。 */
  factory?: IDBFactory | null;
  databaseName?: string;
  storeName?: string;
}

function normalizeError(error: unknown): FilesLargeTextDraftStorageError {
  if (error instanceof FilesLargeTextDraftStorageError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const quota = name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
  return new FilesLargeTextDraftStorageError(quota ? "quota" : "failed", message, {
    cause: error,
  });
}

function isChangeShape(value: unknown): value is FilesLargeTextBlockChange {
  if (!value || typeof value !== "object") return false;
  const change = value as Partial<FilesLargeTextBlockChange>;
  return (
    typeof change.blockIndex === "number" &&
    typeof change.offset === "number" &&
    typeof change.deleteBytes === "number" &&
    typeof change.originalText === "string" &&
    typeof change.text === "string"
  );
}

/** 只校验记录外壳；补丁坐标与有效性由 Store 的既有 sanitizer 负责。 */
export function normalizeFilesLargeTextDraftRecord(
  value: unknown,
): FilesLargeTextDraftRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<FilesLargeTextDraftRecord>;
  if (
    record.schemaVersion !== FILES_LARGE_TEXT_DRAFT_SCHEMA_VERSION ||
    typeof record.bufferId !== "string" ||
    record.bufferId.length === 0 ||
    typeof record.path !== "string" ||
    record.path.length === 0 ||
    typeof record.storageKey !== "string" ||
    record.storageKey.length === 0 ||
    record.storageKey !==
      filesLargeTextDraftRecordStorageKey({
        path: record.path,
        workspaceKey: record.workspaceKey ?? "",
        remoteSessionId: record.remoteSessionId ?? "",
      }) ||
    typeof record.workspaceKey !== "string" ||
    record.workspaceKey.length === 0 ||
    typeof record.remoteSessionId !== "string" ||
    typeof record.baseVersion !== "string" ||
    record.baseVersion.length === 0 ||
    typeof record.baseTotalBytes !== "number" ||
    !Number.isSafeInteger(record.baseTotalBytes) ||
    record.baseTotalBytes < 0 ||
    typeof record.updatedAt !== "number" ||
    !Number.isFinite(record.updatedAt) ||
    !Array.isArray(record.changes) ||
    !record.changes.every(isChangeShape)
  ) {
    return undefined;
  }
  return {
    schemaVersion: FILES_LARGE_TEXT_DRAFT_SCHEMA_VERSION,
    bufferId: record.bufferId,
    path: record.path,
    storageKey: record.storageKey,
    workspaceKey: record.workspaceKey,
    remoteSessionId: record.remoteSessionId,
    baseVersion: record.baseVersion,
    baseTotalBytes: record.baseTotalBytes,
    changes: record.changes.map((change) => ({
      blockIndex: change.blockIndex,
      offset: change.offset,
      deleteBytes: change.deleteBytes,
      originalText: change.originalText,
      text: change.text,
    })),
    updatedAt: record.updatedAt,
  };
}

function openDatabase(
  factory: IDBFactory,
  databaseName: string,
  storeName: string,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, FILES_LARGE_TEXT_DRAFT_DB_VERSION);
    } catch (error) {
      reject(normalizeError(error));
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName, { keyPath: "storageKey" });
        return;
      }
      const existing = request.transaction?.objectStore(storeName);
      if (!existing || existing.keyPath === "storageKey") return;
      // v1 主键是 bufferId，无法区分不同 remoteSession；升级时按记录字段重算复合键。
      const migrated: FilesLargeTextDraftRecord[] = [];
      const cursorRequest = existing.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          const value = cursor.value as Partial<FilesLargeTextDraftRecord>;
          if (
            typeof value.path === "string" &&
            typeof value.workspaceKey === "string" &&
            typeof value.remoteSessionId === "string"
          ) {
            const storageKey = filesLargeTextDraftRecordStorageKey({
              path: value.path,
              workspaceKey: value.workspaceKey,
              remoteSessionId: value.remoteSessionId,
            });
            const record = normalizeFilesLargeTextDraftRecord({ ...value, storageKey });
            if (record) migrated.push(record);
          }
          cursor.continue();
          return;
        }
        database.deleteObjectStore(storeName);
        const next = database.createObjectStore(storeName, { keyPath: "storageKey" });
        for (const record of migrated) next.put(record);
      };
    };
    request.onsuccess = () => {
      const database = request.result;
      // 版本升级由新窗口接管时主动让出，避免长期占用旧连接。
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(normalizeError(request.error));
    request.onblocked = () =>
      reject(new FilesLargeTextDraftStorageError("failed", "indexeddb-open-blocked"));
  });
}

export function createIndexedDbFilesLargeTextDraftStorage(
  options: IndexedDbDraftStorageOptions = {},
): FilesLargeTextDraftStorage {
  const databaseName = options.databaseName ?? FILES_LARGE_TEXT_DRAFT_DB_NAME;
  const storeName = options.storeName ?? FILES_LARGE_TEXT_DRAFT_STORE_NAME;
  const factory = options.factory === undefined ? globalThis.indexedDB : options.factory;
  let databasePromise: Promise<IDBDatabase> | undefined;

  const database = (): Promise<IDBDatabase> => {
    if (!factory) {
      return Promise.reject(
        new FilesLargeTextDraftStorageError("unavailable", "indexeddb-unavailable"),
      );
    }
    if (!databasePromise) {
      databasePromise = openDatabase(factory, databaseName, storeName).catch((error: unknown) => {
        databasePromise = undefined;
        throw normalizeError(error);
      });
    }
    return databasePromise;
  };

  const execute = async <T>(
    mode: IDBTransactionMode,
    operation: (database: IDBDatabase) => Promise<T>,
  ): Promise<T> => {
    const connection = await database();
    try {
      return await operation(connection);
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.kind !== "quota") {
        connection.close();
        databasePromise = undefined;
      }
      throw normalized;
    }
  };

  return {
    load: (storageKey) =>
      execute("readonly", (connection) => {
        return new Promise<FilesLargeTextDraftRecord | undefined>((resolve, reject) => {
          const transaction = connection.transaction(storeName, "readonly");
          const request = transaction.objectStore(storeName).get(storageKey);
          request.onsuccess = () => resolve(normalizeFilesLargeTextDraftRecord(request.result));
          request.onerror = () => reject(normalizeError(request.error));
        });
      }),
    save: (record) =>
      execute("readwrite", (connection) => {
        return new Promise<void>((resolve, reject) => {
          const transaction = connection.transaction(storeName, "readwrite");
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(normalizeError(transaction.error));
          transaction.onabort = () => reject(normalizeError(transaction.error));
          transaction.objectStore(storeName).put(record);
        });
      }),
    delete: (storageKey) =>
      execute("readwrite", (connection) => {
        return new Promise<void>((resolve, reject) => {
          const transaction = connection.transaction(storeName, "readwrite");
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(normalizeError(transaction.error));
          transaction.onabort = () => reject(normalizeError(transaction.error));
          transaction.objectStore(storeName).delete(storageKey);
        });
      }),
  };
}
