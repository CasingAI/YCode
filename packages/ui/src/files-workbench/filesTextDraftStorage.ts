/* eslint-disable max-lines -- v3 记录规范化/迁移与单事务写入共用同一份 revision 契约，拆文件会让原子边界更难审计。 */
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
 *
 * v3 把元数据、当前正文与已保存基线拆到同一数据库的三个 store：
 * - `drafts` 只存身份/标题/epoch/revision，不随正文变化重复克隆；
 * - `bodies` 只在 `bodyRevision` 变化时写入；
 * - `baselines` 只在 `savedRevision` 变化（保存/恢复）时写入。
 * 同一降级事务保证 revision 与正文/基线一起提交，失败时保留旧记录。
 */

export const FILES_TEXT_DRAFT_SCHEMA_VERSION = 3;
export const FILES_TEXT_DRAFT_DB_NAME = "zcode-files-text-drafts";
export const FILES_TEXT_DRAFT_STORE_NAME = "drafts";
export const FILES_TEXT_DRAFT_BODY_STORE_NAME = "bodies";
export const FILES_TEXT_DRAFT_BASELINE_STORE_NAME = "baselines";
/** v2 起主键改为包含 workspace / remoteSession / path 的 storageKey；v3 拆分正文与基线。 */
export const FILES_TEXT_DRAFT_DB_VERSION = 3;

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
  /** 当前正文快照；读取时由 bodies store 组合。 */
  text: string;
  /** 已保存基线；读取时由 baselines store 组合。 */
  savedText: string;
  /** 用于重建 FilesWorkspaceRef；隔离判定只使用上面的复合键。 */
  workspace: FilesWorkspaceRef;
  untitled: boolean;
  /** 旧版 256 KiB 截断草稿标记；恢复后仍不可保存。 */
  truncated?: boolean;
  updatedAt: number;
  /** 当前正文变更代次；未变化时不重写 bodies。 */
  bodyRevision: number;
  /** 已保存基线代次；未变化时不重写 baselines。 */
  savedRevision: number;
}

export interface FilesTextDraftRevisions {
  bodyRevision: number;
  savedRevision: number;
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

function finiteRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function createFilesTextDraftRecord(
  draft: FilesPersistedDraft,
  updatedAt: number,
  revisions?: FilesTextDraftRevisions,
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
    bodyRevision: revisions?.bodyRevision ?? updatedAt,
    savedRevision: revisions?.savedRevision ?? updatedAt,
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

interface FilesTextDraftMetadata extends Omit<FilesTextDraftRecord, "text" | "savedText"> {}

/**
 * v3 元数据校验；正文/基线不在 metadata 里，由调用方按 revision 组合。
 */
function normalizeFilesTextDraftMetadata(value: unknown): FilesTextDraftMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<FilesTextDraftMetadata>;
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
    (record.untitled !== true && record.untitled !== false) ||
    !finiteRevision(record.updatedAt) ||
    !finiteRevision(record.bodyRevision) ||
    !finiteRevision(record.savedRevision) ||
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
    workspace: record.workspace,
    untitled: record.untitled,
    ...(record.truncated === true ? { truncated: true } : undefined),
    updatedAt: record.updatedAt,
    bodyRevision: record.bodyRevision,
    savedRevision: record.savedRevision,
  };
}

/**
 * v2 记录仍可能存在于旧数据库：读取时按 updatedAt 生成正文/基线 revision，
 * 下一次 save 会原子升级为 v3 的 metadata + body + baseline。
 */
function normalizeLegacyFilesTextDraftRecord(value: unknown): FilesTextDraftRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  // 旧记录可能来自 v2 schema，这里按 number 读取以允许检查历史版本号。
  const record = value as Omit<Partial<FilesTextDraftRecord>, "schemaVersion"> & {
    schemaVersion?: number;
  };
  if (
    record.schemaVersion !== 2 ||
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
    !finiteRevision(record.updatedAt) ||
    !isWorkspaceRef(record.workspace) ||
    (record.path !== undefined && typeof record.path !== "string")
  ) {
    return undefined;
  }
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
    bodyRevision: record.updatedAt,
    savedRevision: record.updatedAt,
  };
}

export function normalizeFilesTextDraftRecord(value: unknown): FilesTextDraftRecord | undefined {
  const legacy = normalizeLegacyFilesTextDraftRecord(value);
  if (legacy) return legacy;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<FilesTextDraftRecord>;
  if (typeof record.text !== "string" || typeof record.savedText !== "string") return undefined;
  const metadata = normalizeFilesTextDraftMetadata(value);
  if (!metadata) return undefined;
  return { ...metadata, text: record.text, savedText: record.savedText };
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
    updatedAt: finiteRevision(legacy.updatedAt) ? legacy.updatedAt : 0,
    bodyRevision: finiteRevision(legacy.updatedAt) ? legacy.updatedAt : 0,
    savedRevision: finiteRevision(legacy.updatedAt) ? legacy.updatedAt : 0,
  });
}

function metadataWithoutText(record: FilesTextDraftRecord): FilesTextDraftMetadata {
  return {
    schemaVersion: record.schemaVersion,
    bufferId: record.bufferId,
    ...(record.path === undefined ? undefined : { path: record.path }),
    title: record.title,
    storageKey: record.storageKey,
    workspaceKey: record.workspaceKey,
    remoteSessionId: record.remoteSessionId,
    workspace: record.workspace,
    untitled: record.untitled,
    ...(record.truncated === true ? { truncated: true } : undefined),
    updatedAt: record.updatedAt,
    bodyRevision: record.bodyRevision,
    savedRevision: record.savedRevision,
  };
}

/**
 * 判断一次保存是否需要重写 bodies / baselines。
 *
 * v2 / v1 记录把正文留在 metadata 里，即使 revision 恰好相同也必须拆分一次；
 * v3 记录只有 revision 变化时才写对应 store，未变基线不随正文重写。
 * `existingParts` 来自 key-only 存在性检查：metadata 已提交但 part 缺失时
 * 即使 revision 未变也必须补写，避免后续 load 永久失败。
 */
export function filesTextDraftPartChanges(
  previous:
    | {
        schemaVersion?: unknown;
        bodyRevision?: unknown;
        savedRevision?: unknown;
        text?: unknown;
        savedText?: unknown;
      }
    | undefined,
  next: Pick<FilesTextDraftRecord, "bodyRevision" | "savedRevision">,
  existingParts?: { body?: boolean; baseline?: boolean },
): { body: boolean; baseline: boolean } {
  const previousIsFull =
    typeof previous?.text === "string" || typeof previous?.savedText === "string";
  const previousBodyRevision =
    !previousIsFull &&
    previous?.schemaVersion === FILES_TEXT_DRAFT_SCHEMA_VERSION &&
    finiteRevision(previous.bodyRevision)
      ? previous.bodyRevision
      : undefined;
  const previousSavedRevision =
    !previousIsFull &&
    previous?.schemaVersion === FILES_TEXT_DRAFT_SCHEMA_VERSION &&
    finiteRevision(previous.savedRevision)
      ? previous.savedRevision
      : undefined;
  return {
    body: previousBodyRevision !== next.bodyRevision || existingParts?.body === false,
    baseline: previousSavedRevision !== next.savedRevision || existingParts?.baseline === false,
  };
}

function openDatabase(
  factory: IDBFactory,
  databaseName: string,
  storeNames: { drafts: string; bodies: string; baselines: string },
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
      const transaction = request.transaction;
      if (!transaction) return;
      const ensurePartStore = (name: string): void => {
        if (!database.objectStoreNames.contains(name)) {
          database.createObjectStore(name, { keyPath: "storageKey" });
        }
      };
      if (!database.objectStoreNames.contains(storeNames.drafts)) {
        database.createObjectStore(storeNames.drafts, { keyPath: "storageKey" });
        ensurePartStore(storeNames.bodies);
        ensurePartStore(storeNames.baselines);
        return;
      }
      const existing = transaction.objectStore(storeNames.drafts);
      if (existing.keyPath === "storageKey") {
        // v2 -> v3：旧整条记录继续可读，下一次 save 原子拆分为三个 store。
        ensurePartStore(storeNames.bodies);
        ensurePartStore(storeNames.baselines);
        return;
      }
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
        database.deleteObjectStore(storeNames.drafts);
        const next = database.createObjectStore(storeNames.drafts, { keyPath: "storageKey" });
        for (const record of migrated) next.put(record);
        ensurePartStore(storeNames.bodies);
        ensurePartStore(storeNames.baselines);
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
    bodyStoreName?: string;
    baselineStoreName?: string;
  } = {},
): FilesTextDraftStorage {
  const databaseName = options.databaseName ?? FILES_TEXT_DRAFT_DB_NAME;
  const storeNames = {
    drafts: options.storeName ?? FILES_TEXT_DRAFT_STORE_NAME,
    bodies: options.bodyStoreName ?? FILES_TEXT_DRAFT_BODY_STORE_NAME,
    baselines: options.baselineStoreName ?? FILES_TEXT_DRAFT_BASELINE_STORE_NAME,
  };
  const factory = options.factory === undefined ? globalThis.indexedDB : options.factory;
  let databasePromise: Promise<IDBDatabase> | undefined;

  const database = (): Promise<IDBDatabase> => {
    if (!factory) {
      return Promise.reject(new FilesTextDraftStorageError("unavailable", "indexeddb-unavailable"));
    }
    if (!databasePromise) {
      databasePromise = openDatabase(factory, databaseName, storeNames).catch((error: unknown) => {
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

  const requestPart = <T>(
    transaction: IDBTransaction,
    storeName: string,
    storageKey: string,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const request = transaction.objectStore(storeName).get(storageKey);
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(normalizeError(request.error));
    });

  return {
    load: (storageKey) =>
      execute(
        (connection) =>
          new Promise<FilesTextDraftRecord | undefined>((resolve, reject) => {
            const transaction = connection.transaction(
              [storeNames.drafts, storeNames.bodies, storeNames.baselines],
              "readonly",
            );
            const metadataRequest = transaction.objectStore(storeNames.drafts).get(storageKey);
            metadataRequest.onsuccess = () => {
              const raw = metadataRequest.result as unknown;
              const legacy = normalizeLegacyFilesTextDraftRecord(raw);
              if (legacy) {
                resolve(legacy);
                return;
              }
              // v1 升级或早期写入可能把完整正文留在 drafts 里；下一次 save 会拆分。
              const full = normalizeFilesTextDraftRecord(raw);
              if (full) {
                resolve(full);
                return;
              }
              const metadata = normalizeFilesTextDraftMetadata(raw);
              if (!metadata) {
                reject(new FilesTextDraftStorageError("failed", "draft-metadata-invalid"));
                return;
              }
              void Promise.all([
                requestPart<{ revision?: unknown; text?: unknown } | undefined>(
                  transaction,
                  storeNames.bodies,
                  storageKey,
                ),
                requestPart<{ revision?: unknown; text?: unknown } | undefined>(
                  transaction,
                  storeNames.baselines,
                  storageKey,
                ),
              ])
                .then(([body, baseline]) => {
                  if (
                    !body ||
                    !baseline ||
                    body.revision !== metadata.bodyRevision ||
                    baseline.revision !== metadata.savedRevision ||
                    typeof body.text !== "string" ||
                    typeof baseline.text !== "string"
                  ) {
                    reject(new FilesTextDraftStorageError("failed", "draft-parts-missing"));
                    return;
                  }
                  resolve({
                    ...metadata,
                    text: body.text,
                    savedText: baseline.text,
                  });
                })
                .catch((error: unknown) => reject(normalizeError(error)));
            };
            metadataRequest.onerror = () => reject(normalizeError(metadataRequest.error));
          }),
      ),
    save: (record) =>
      execute(
        (connection) =>
          new Promise<void>((resolve, reject) => {
            const transaction = connection.transaction(
              [storeNames.drafts, storeNames.bodies, storeNames.baselines],
              "readwrite",
            );
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(normalizeError(transaction.error));
            transaction.onabort = () => reject(normalizeError(transaction.error));
            const drafts = transaction.objectStore(storeNames.drafts);
            const previousRequest = drafts.get(record.storageKey);
            previousRequest.onsuccess = () => {
              const previous = previousRequest.result as
                | {
                    schemaVersion?: unknown;
                    bodyRevision?: unknown;
                    savedRevision?: unknown;
                    text?: unknown;
                    savedText?: unknown;
                  }
                | undefined;
              const initial = filesTextDraftPartChanges(previous, record);
              const existingParts: { body?: boolean; baseline?: boolean } = {};
              let pendingChecks = 0;
              const finalize = () => {
                const changes = filesTextDraftPartChanges(previous, record, existingParts);
                drafts.put(metadataWithoutText(record));
                if (changes.body) {
                  transaction.objectStore(storeNames.bodies).put({
                    storageKey: record.storageKey,
                    revision: record.bodyRevision,
                    text: record.text,
                  });
                }
                if (changes.baseline) {
                  transaction.objectStore(storeNames.baselines).put({
                    storageKey: record.storageKey,
                    revision: record.savedRevision,
                    text: record.savedText,
                  });
                }
              };
              // revision 未变时仍要确认 part 实际存在。count 只查主键，不读取或
              // 克隆大正文；metadata 存在但 bodies/baselines 缺失时补写，避免
              // 后续 load 永久报 draft-parts-missing，也避免误把数据当不存在。
              const checkPart = (part: "body" | "baseline"): void => {
                pendingChecks += 1;
                const request = transaction
                  .objectStore(part === "body" ? storeNames.bodies : storeNames.baselines)
                  .count(record.storageKey);
                request.onsuccess = () => {
                  if (part === "body") existingParts.body = request.result > 0;
                  else existingParts.baseline = request.result > 0;
                  pendingChecks -= 1;
                  if (pendingChecks === 0) finalize();
                };
              };
              if (!initial.body) checkPart("body");
              if (!initial.baseline) checkPart("baseline");
              if (pendingChecks === 0) finalize();
            };
            previousRequest.onerror = () => reject(normalizeError(previousRequest.error));
          }),
      ),
    delete: (storageKey) =>
      execute(
        (connection) =>
          new Promise<void>((resolve, reject) => {
            const transaction = connection.transaction(
              [storeNames.drafts, storeNames.bodies, storeNames.baselines],
              "readwrite",
            );
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(normalizeError(transaction.error));
            transaction.onabort = () => reject(normalizeError(transaction.error));
            transaction.objectStore(storeNames.drafts).delete(storageKey);
            transaction.objectStore(storeNames.bodies).delete(storageKey);
            transaction.objectStore(storeNames.baselines).delete(storageKey);
          }),
      ),
  };
}
