import { logger } from "@/logger.js";
import { filesWorkspaceKey } from "@/files-workbench/filesEditorBufferModel.js";
import {
  createFilesTextDraftRecord,
  createIndexedDbFilesTextDraftStorage,
  filesTextDraftRecordToPersistedDraft,
  filesTextDraftRemoteSessionId,
  filesTextDraftStorageKey,
  type FilesTextDraftRecord,
  type FilesTextDraftStorage,
} from "@/files-workbench/filesTextDraftStorage.js";
import {
  getFilesEditorSessionBrowserStorage,
  readFilesEditorSession,
  snapshotFilesEditorSession,
  writeFilesEditorSession,
  type FilesEditorSessionStorage,
} from "@/files-workbench/filesEditorPersistence.js";
import type {
  FilesEditorState,
  FilesPersistedSession,
} from "@/files-workbench/filesEditorTypes.js";

/**
 * 会话持久化 owner：localStorage 同步写入 + IndexedDB 异步备份。
 *
 * localStorage 是同步基线，IndexedDB 只保存超预算草稿并按 storageKey 隔离。
 * 每次 persist 整体替换 desired 意图；drain 在每次 save / delete 完成后
 * 再核对最新 desired，保证 clean / 关闭或更新编辑不会被在途旧操作覆盖。
 */

const DRAFT_IDB_DEBOUNCE_MS = 300;

export interface FilesEditorSessionPersistence {
  /** 立即写 localStorage，并把超预算草稿异步排队到 IndexedDB。 */
  persist: () => void;
  /** 读取 localStorage 会话，再按 epoch 合并打开标签对应的 IndexedDB 大草稿。 */
  load: () => Promise<FilesPersistedSession | undefined>;
  /** 等待所有 IndexedDB 写入 / 删除完成。 */
  flush: () => Promise<void>;
}

export interface FilesEditorSessionPersistenceOptions {
  store: Pick<{ getState: () => FilesEditorState }, "getState">;
  storage?: FilesEditorSessionStorage;
  draftStorage?: FilesTextDraftStorage;
  now?: () => number;
  /** 0 表示不延迟（测试用）。 */
  debounceMs?: number;
  log?: Pick<typeof logger, "warn">;
}

interface DesiredDraft {
  record: FilesTextDraftRecord;
  /** 每次 desired 变更递增；save 完成后用它判断是否又有更新编辑。 */
  revision: number;
}

export function createFilesEditorSessionPersistence(
  options: FilesEditorSessionPersistenceOptions,
): FilesEditorSessionPersistence {
  const { store } = options;
  const storage =
    options.storage === undefined ? getFilesEditorSessionBrowserStorage() : options.storage;
  const draftStorage = options.draftStorage ?? createIndexedDbFilesTextDraftStorage();
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? DRAFT_IDB_DEBOUNCE_MS;
  const log = options.log ?? logger;

  /** 当前期望留在 IndexedDB 的记录，按 storageKey 索引。 */
  const desired = new Map<string, DesiredDraft>();
  /** 已确认存在于 IndexedDB 的 storageKey（load 命中或 save 成功）。 */
  const persistedKeys = new Set<string>();
  /** 仍需要 reconcile 的 storageKey；drain 每次只处理一个并重新核对 desired。 */
  const pendingKeys = new Set<string>();
  let revision = 0;
  let lastStamp = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let draining: Promise<void> | undefined;

  // 同一 persist 的 localStorage 草稿与 IndexedDB 溢出记录使用同一个 epoch；
  // 进程内至少单调递增，避免系统时间回拨让旧记录看起来更新。
  const nextStamp = (): number => {
    const current = now();
    lastStamp = current > lastStamp ? current : lastStamp + 1;
    return lastStamp;
  };

  const drain = async (): Promise<void> => {
    if (draining) {
      await draining;
      return;
    }
    draining = (async () => {
      while (pendingKeys.size > 0) {
        const storageKey = pendingKeys.values().next().value as string;
        const entry = desired.get(storageKey);
        if (entry) {
          const targetRevision = entry.revision;
          try {
            await draftStorage.save(entry.record);
            persistedKeys.add(storageKey);
            // save 成功后二次核对：期间已 clean / 关闭则不能把记录留在 IndexedDB。
            if (desired.get(storageKey)?.revision === targetRevision) {
              pendingKeys.delete(storageKey);
            }
          } catch (error) {
            // 配额 / 数据库不可用只记录带路径的告警，不阻断编辑；下一次 persist 重试。
            // 若期间已不需要该草稿，保留 pending 以便下面删除旧的已存在记录。
            if (!desired.has(storageKey) && persistedKeys.has(storageKey)) {
              // keep pending for delete
            } else {
              pendingKeys.delete(storageKey);
            }
            log.warn("[files-workbench] 完整文本草稿写入 IndexedDB 失败", {
              storageKey,
              path: entry.record.path,
              error,
            });
          }
          continue;
        }
        try {
          if (persistedKeys.has(storageKey)) {
            await draftStorage.delete(storageKey);
            persistedKeys.delete(storageKey);
          }
          // delete 成功后二次核对：期间重新变脏则保留 pending 继续写最新正文。
          if (!desired.has(storageKey)) pendingKeys.delete(storageKey);
        } catch (error) {
          pendingKeys.delete(storageKey);
          log.warn("[files-workbench] 完整文本草稿清理 IndexedDB 失败", { storageKey, error });
        }
      }
    })();
    try {
      await draining;
    } finally {
      draining = undefined;
    }
    if (pendingKeys.size > 0) {
      await drain();
    }
  };

  const schedule = (): void => {
    if (debounceMs <= 0) {
      void drain();
      return;
    }
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void drain();
    }, debounceMs);
  };

  const persist = (): void => {
    const stamp = nextStamp();
    const session = snapshotFilesEditorSession(store.getState());
    // 每个草稿都记录合并 epoch；溢出记录沿用同一 epoch，冷启动才能证明哪一份更新。
    const stampedSession: FilesPersistedSession = {
      ...session,
      drafts: session.drafts.map((draft) => ({ ...draft, updatedAt: stamp })),
    };
    const result = writeFilesEditorSession(stampedSession, storage);
    if (result.status !== "written") {
      log.warn("[files-workbench] 文件会话未能完整写入 localStorage", {
        status: result.status,
        overflowDrafts: result.overflowDrafts.length,
      });
    }

    const nextDesired = new Map<string, DesiredDraft>();
    const nextRevision = ++revision;
    for (const draft of result.overflowDrafts) {
      const record = createFilesTextDraftRecord(draft, draft.updatedAt ?? stamp);
      nextDesired.set(record.storageKey, { record, revision: nextRevision });
    }

    // 不再 desired 的 key（clean / 关闭 / 回到本地预算）必须进入删除集合。
    for (const storageKey of desired.keys()) {
      if (!nextDesired.has(storageKey)) pendingKeys.add(storageKey);
    }
    // 已落盘但当前不想保留的记录也要清理，包括上次删除失败后的重试。
    for (const storageKey of persistedKeys) {
      if (!nextDesired.has(storageKey)) pendingKeys.add(storageKey);
    }
    desired.clear();
    for (const [storageKey, entry] of nextDesired) {
      desired.set(storageKey, entry);
      pendingKeys.add(storageKey);
    }
    if (pendingKeys.size > 0) schedule();
  };

  const load = async (): Promise<FilesPersistedSession | undefined> => {
    const session = readFilesEditorSession(storage);
    if (!session) return undefined;
    const drafts = [...session.drafts];
    const indexById = new Map(drafts.map((draft, index) => [draft.id, index]));
    const openTabById = new Map(session.openTabs.map((tab) => [tab.id, tab]));
    const ids = [...new Set([...session.openFileIds, ...drafts.map((draft) => draft.id)])];
    for (const id of ids) {
      const localIndex = indexById.get(id);
      const localDraft = localIndex === undefined ? undefined : drafts[localIndex];
      const tab = openTabById.get(id);
      const workspace = localDraft?.workspace ?? tab?.workspace;
      const path = localDraft?.path ?? tab?.path;
      if (!workspace) continue;
      // storageKey 只由会话身份计算，不按 bufferId、仅路径或仅 workspace 猜测。
      const workspaceKey = filesWorkspaceKey(workspace);
      const remoteSessionId = filesTextDraftRemoteSessionId(workspace);
      const storageKey = filesTextDraftStorageKey({
        workspaceKey,
        remoteSessionId,
        path,
        bufferId: id,
      });
      let record: FilesTextDraftRecord | undefined;
      try {
        record = await draftStorage.load(storageKey);
      } catch (error) {
        // IndexedDB 不可用时保留 localStorage 会话，不因此清空标签或小草稿。
        log.warn("[files-workbench] 完整文本草稿读取 IndexedDB 失败", { storageKey, error });
        continue;
      }
      if (!record) continue;
      // 防御实现或迁移边界：记录身份与本次计算不一致时忽略，且不得删除其它 owner。
      if (
        record.storageKey !== storageKey ||
        record.workspaceKey !== workspaceKey ||
        record.remoteSessionId !== remoteSessionId
      ) {
        continue;
      }
      if (
        localDraft &&
        (localDraft.updatedAt === undefined || localDraft.updatedAt >= record.updatedAt)
      ) {
        // localStorage 是同步基线：本地缺 epoch 或 epoch 不早于 IndexedDB 时本地胜出。
        persistedKeys.add(storageKey);
        if (!desired.has(storageKey)) {
          pendingKeys.add(storageKey);
          schedule();
        }
        continue;
      }
      // IndexedDB 是更新版本（如 localStorage 写失败保留旧会话），或本地只有标签元数据。
      persistedKeys.add(storageKey);
      const draft = { ...filesTextDraftRecordToPersistedDraft(record), id };
      if (localIndex === undefined) {
        indexById.set(id, drafts.length);
        drafts.push(draft);
      } else {
        drafts[localIndex] = draft;
      }
    }
    return { ...session, drafts };
  };

  const flush = async (): Promise<void> => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    await drain();
  };

  return { persist, load, flush };
}

interface FilesEditorSessionPersistableStore {
  getState: () => FilesEditorState;
}

const persistenceOwners = new WeakMap<object, FilesEditorSessionPersistence>();

/** 控制器挂载时登记，文件树等非 hook 入口也能复用同一持久化 owner。 */
export function registerFilesEditorSessionPersistence(
  store: object,
  persistence: FilesEditorSessionPersistence,
): () => void {
  persistenceOwners.set(store, persistence);
  return () => {
    if (persistenceOwners.get(store) === persistence) {
      persistenceOwners.delete(store);
    }
  };
}

/**
 * 非 hook 入口（文件树改名 / 删除）的会话持久化。
 *
 * owner 未注册时退回同步 localStorage 写入；大草稿无法在此异步备份，必须记录
 * 告警而不是静默丢弃。正常挂载路径总会先注册 owner。
 */
export function persistFilesEditorSession(store: FilesEditorSessionPersistableStore): void {
  const owner = persistenceOwners.get(store);
  if (owner) {
    owner.persist();
    return;
  }
  const session = snapshotFilesEditorSession(store.getState());
  const stamp = Date.now();
  const result = writeFilesEditorSession({
    ...session,
    drafts: session.drafts.map((draft) => ({ ...draft, updatedAt: stamp })),
  });
  if (result.overflowDrafts.length > 0) {
    logger.warn("[files-workbench] 无持久化 owner，未备份完整文本大草稿", {
      drafts: result.overflowDrafts.map((draft) => draft.path ?? draft.id),
    });
  }
}
