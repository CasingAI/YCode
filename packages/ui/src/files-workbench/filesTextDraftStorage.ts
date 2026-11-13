import { filesWorkspaceKey } from "@/files-workbench/filesEditorBufferModel.js";
import type { FilesPersistedDraft, FilesWorkspaceRef } from "@/files-workbench/filesEditorTypes.js";

/**
 * 完整文本草稿的 IndexedDB 适配器。
 *
 * localStorage 只保存标签与小体积草稿；超过本地预算的完整文本草稿写到这里，
 * 避免 10 MiB 级草稿触发配额失败后被静默丢弃。运行时的唯一草稿 owner 仍是
 * Files Editor Store，本存储只做异步备份，不参与保存冲突判定。
 *
 * 记录隔离键是 `workspaceKey + remoteSessionId + (path ?? bufferId)`，
 * 不复用也不改写全局 bufferId。
 */

export const FILES_TEXT_DRAFT_SCHEMA_VERSION = 2;
export const FILES_TEXT_DRAFT_DB_NAME = "zcode-files-text-drafts";
export const FILES_TEXT_DRAFT_STORE_NAME = "drafts";
/** v2 起主键改为包含 workspace / remoteSession / path 的 storageKey。 */
export const FILES_TEXT_DRAFT_DB_VERSION = 2;

export interface FilesTextDraftRecord {
  schemaVersion: typeof FILES_TEXT_DRAFT_SCHEMA_VERSION;
  /** 运行时 bufferId；只用于与标签关联，不承担隔离。 */
  bufferId: string;
  path?: string;
  title: string;
  /** workspaceKey + remoteSessionId + (path ?? bufferId)；IndexedDB 主键。 */
  storageKey: string;
  /** `workspaceIdentity?.trim() || workspacePath`。 */
  workspaceKey: string;
  /** 远端工作区会话标识；本地为空串。 */
  remoteSessionId: string;
  text: string;
  savedText: string;
  /** 用于重建 FilesWorkspaceRef；隔离判定只使用上面的复合键。 */
  workspace: FilesWorkspaceRef;
  untitled: boolean;
  /** 旧版 256 KiB 截断草稿标记；恢复后仍不可保存。 */
  truncated?: boolean;
  updatedAt: number;
}

export type FilesTextDraftStorageErrorKind = "unavailable" | "quota" | "failed";

export class FilesTextDraftStorageError extends Error {
  readonly kind: FilesTextDraftStorageErrorKind;

  constructor(kind: FilesTextDraftStorageErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FilesTextDraftStorageError";
    this.kind = kind;
  }
}

/** 可被测试 fake 实现；持久化控制器只依赖该接口。 */
export interface FilesTextDraftStorage {
  load(storageKey: string): Promise<FilesTextDraftRecord | undefined>;
  save(record: FilesTextDraftRecord): Promise<void>;
  delete(storageKey: string): Promise<void>;
}

export function filesTextDraftStorageKey(owner: {
  workspaceKey: string;
  remoteSessionId: string;
  path?: string;
  bufferId: string;
}): string {
  return [owner.workspaceKey, owner.remoteSessionId, owner.path || owner.bufferId].join("\u0000");
}

export function filesTextDraftRecordStorageKey(
  record: Pick<FilesTextDraftRecord, "workspaceKey" | "remoteSessionId" | "path" | "bufferId">,
): string {
  return filesTextDraftStorageKey(record);
}

export function filesTextDraftRemoteSessionId(workspace: FilesWorkspaceRef): string {
  return workspace.workspaceRemoteSessionId?.trim() ?? "";
}

function normalizeError(error: unknown): FilesTextDraftStorageError {
  if (error instanceof FilesTextDraftStorageError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const quota = name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
  return new FilesTextDraftStorageError(quota ? "quota" : "failed", message, { cause: error });
}

function isWorkspaceRef(value: unknown): value is FilesWorkspaceRef {
  if (!value || typeof value !== "object") return false;
  const workspace = value as { workspacePath?: unknown };
  return typeof workspace.workspacePath === "string" && workspace.workspacePath.length > 0;
}

export function createFilesTextDraftRecord(
  draft: FilesPersistedDraft,
  updatedAt: number,
): FilesTextDraftRecord {
  const workspaceKey = filesWorkspaceKey(draft.workspace);
  const remoteSessionId = filesTextDraftRemoteSessionId(draft.workspace);
  return {
    schemaVersion: FILES_TEXT_DRAFT_SCHEMA_VERSION,
    bufferId: draft.id,
    ...(draft.path === undefined ? undefined : { path: draft.path }),
    title: draft.title,
    storageKey: filesTextDraftStorageKey({
      workspaceKey,
      remoteSessionId,
      path: draft.path,
      bufferId: draft.id,
    }),
    workspaceKey,
    remoteSessionId,
    text: draft.text,
    savedText: draft.savedText,
    workspace: draft.workspace,
    untitled: draft.untitled,
    ...(draft.truncated === true ? { truncated: true } : undefined),
    updatedAt,
  };
}

export function filesTextDraftRecordToPersistedDraft(
  record: FilesTextDraftRecord,
): FilesPersistedDraft {
  return {
    id: record.bufferId,
    path: record.path,
    title: record.title,
    text: record.text,
    savedText: record.savedText,
    workspace: record.workspace,
    untitled: record.untitled,
    updatedAt: record.updatedAt,
    truncated: record.truncated === true ? true : undefined,
  };
}

export function normalizeFilesTextDraftRecord(value: unknown): FilesTextDraftRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<FilesTextDraftRecord>;
  if (
    record.schemaVersion !== FILES_TEXT_DRAFT_SCHEMA_VERSION ||
    typeof record.bufferId !== "string" ||
    record.bufferId.length === 0 ||
    typeof record.storageKey !== "string" ||
    record.storageKey.length === 0 ||
    typeof record.workspaceKey !== "string" ||
    record.workspaceKey.length === 0 ||
    typeof record.remoteSessionId !== "string" ||
    typeof record.title !== "string" ||
    typeof record.text !== "string" ||
    typeof record.savedText !== "string" ||
    (record.untitled !== true && record.untitled !== false) ||
    typeof record.updatedAt !== "number" ||
    !Number.isFinite(record.updatedAt) ||
    !isWorkspaceRef(record.workspace) ||
    (record.path !== undefined && typeof record.path !== "string")
  ) {
    return undefined;
  }
  // 身份字段必须与 workspace 自洽，避免把别的 owner 的正文合并进当前会话。
  if (filesWorkspaceKey(record.workspace) !== record.workspaceKey) return undefined;
  if (filesTextDraftRemoteSessionId(record.workspace) !== record.remoteSessionId) return undefined;
  const expectedStorageKey = filesTextDraftRecordStorageKey({
    workspaceKey: record.workspaceKey,
    remoteSessionId: record.remoteSessionId,
    path: record.path,
    bufferId: record.bufferId,
  });
  if (record.storageKey !== expectedStorageKey) return undefined;
  return {
    schemaVersion: FILES_TEXT_DRAFT_SCHEMA_VERSION,
    bufferId: record.bufferId,
    ...(record.path === undefined ? undefined : { path: record.path }),
    title: record.title,
    storageKey: record.storageKey,
    workspaceKey: record.workspaceKey,
    remoteSessionId: record.remoteSessionId,
    text: record.text,
    savedText: record.savedText,
    workspace: record.workspace,
    untitled: record.untitled,
    ...(record.truncated === true ? { truncated: true } : undefined),
    updatedAt: record.updatedAt,
  };
}

/** v1 记录只按 bufferId 存主键；升级时按 workspace 字段重算复合 storageKey。 */
function migrateV1Record(value: unknown): FilesTextDraftRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const legacy = value as {
    id?: unknown;
    path?: unknown;
    title?: unknown;
    text?: unknown;
    savedText?: unknown;
    workspace?: unknown;
    untitled?: unknown;
    truncated?: unknown;
    updatedAt?: unknown;
  };
  if (
    typeof legacy.id !== "string" ||
    legacy.id.length === 0 ||
    typeof legacy.title !== "string" ||
    typeof legacy.text !== "string" ||
    typeof legacy.savedText !== "string" ||
    !isWorkspaceRef(legacy.workspace) ||
    (legacy.untitled !== true && legacy.untitled !== false) ||
    (legacy.path !== undefined && typeof legacy.path !== "string")
  ) {
    return undefined;
  }
  const workspaceKey = filesWorkspaceKey(legacy.workspace);
  const remoteSessionId = filesTextDraftRemoteSessionId(legacy.workspace);
  return normalizeFilesTextDraftRecord({
    schemaVersion: FILES_TEXT_DRAFT_SCHEMA_VERSION,
    bufferId: legacy.id,
    path: legacy.path,
    title: legacy.title,
    storageKey: filesTextDraftStorageKey({
      workspaceKey,
      remoteSessionId,
      path: legacy.path,
      bufferId: legacy.id,
    }),
    workspaceKey,
    remoteSessionId,
    text: legacy.text,
    savedText: legacy.savedText,
    workspace: legacy.workspace,
    untitled: legacy.untitled,
    truncated: legacy.truncated === true ? true : undefined,
    updatedAt:
      typeof legacy.updatedAt === "number" && Number.isFinite(legacy.updatedAt)
        ? legacy.updatedAt
        : 0,
  });
}

function openDatabase(
  factory: IDBFactory,
  databaseName: string,
  storeName: string,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, FILES_TEXT_DRAFT_DB_VERSION);
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
      // v1 主键是 bufferId，无法区分不同 remoteSession；升级时按身份字段重算复合键。
      const migrated: FilesTextDraftRecord[] = [];
      const cursorRequest = existing.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          const record = migrateV1Record(cursor.value);
          if (record) migrated.push(record);
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
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(normalizeError(request.error));
    request.onblocked = () =>
      reject(new FilesTextDraftStorageError("failed", "indexeddb-open-blocked"));
  });
}

export function createIndexedDbFilesTextDraftStorage(
  options: {
    /** 显式传入 null 可模拟无 IndexedDB 环境。 */
    factory?: IDBFactory | null;
    databaseName?: string;
    storeName?: string;
  } = {},
): FilesTextDraftStorage {
  const databaseName = options.databaseName ?? FILES_TEXT_DRAFT_DB_NAME;
  const storeName = options.storeName ?? FILES_TEXT_DRAFT_STORE_NAME;
  const factory = options.factory === undefined ? globalThis.indexedDB : options.factory;
  let databasePromise: Promise<IDBDatabase> | undefined;

  const database = (): Promise<IDBDatabase> => {
    if (!factory) {
      return Promise.reject(new FilesTextDraftStorageError("unavailable", "indexeddb-unavailable"));
    }
    if (!databasePromise) {
      databasePromise = openDatabase(factory, databaseName, storeName).catch((error: unknown) => {
        databasePromise = undefined;
        throw normalizeError(error);
      });
    }
    return databasePromise;
  };

  const execute = async <T>(operation: (database: IDBDatabase) => Promise<T>): Promise<T> => {
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
      execute(
        (connection) =>
          new Promise<FilesTextDraftRecord | undefined>((resolve, reject) => {
            const transaction = connection.transaction(storeName, "readonly");
            const request = transaction.objectStore(storeName).get(storageKey);
            request.onsuccess = () => resolve(normalizeFilesTextDraftRecord(request.result));
            request.onerror = () => reject(normalizeError(request.error));
          }),
      ),
    save: (record) =>
      execute(
        (connection) =>
          new Promise<void>((resolve, reject) => {
            const transaction = connection.transaction(storeName, "readwrite");
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(normalizeError(transaction.error));
            transaction.onabort = () => reject(normalizeError(transaction.error));
            transaction.objectStore(storeName).put(record);
          }),
      ),
    delete: (storageKey) =>
      execute(
        (connection) =>
          new Promise<void>((resolve, reject) => {
            const transaction = connection.transaction(storeName, "readwrite");
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(normalizeError(transaction.error));
            transaction.onabort = () => reject(normalizeError(transaction.error));
            transaction.objectStore(storeName).delete(storageKey);
          }),
      ),
  };
}
