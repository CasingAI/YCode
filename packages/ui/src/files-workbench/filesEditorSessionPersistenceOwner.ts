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
/**
 * 局部输入后的持久化去抖。运行中每键只递增 textChangeEpoch，不读正文；
 * 计时器只在输入停顿后触发一次 snapshot，关闭 / 隐藏仍显式 persist。
 */
const DRAFT_TEXT_PERSIST_DEBOUNCE_MS = 300;

export interface FilesEditorSessionPersistence {
  /** 立即写 localStorage，并把超预算草稿异步排队到 IndexedDB。 */
  persist: () => void;
  /** 局部正文输入：只记录代次并去抖，不读取正文、不写存储。 */
  noteTextChange: () => void;
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
  /** IndexedDB 写入去抖；0 表示不延迟（测试用）。 */
  debounceMs?: number;
  /** 局部正文输入后的持久化去抖；0 表示立即 persist（测试用）。 */
  textPersistDebounceMs?: number;
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
  const textPersistDebounceMs = options.textPersistDebounceMs ?? DRAFT_TEXT_PERSIST_DEBOUNCE_MS;
  const log = options.log ?? logger;

  /** 当前期望留在 IndexedDB 的记录，按 storageKey 索引。 */
  const desired = new Map<string, DesiredDraft>();
  /** 已确认存在于 IndexedDB 的 storageKey（load 命中或 save 成功）。 */
  const persistedKeys = new Set<string>();
  /**
   * load 命中的记录只能证明“整条可读”，不能证明已按 v3 拆分。
   * v2 整条记录 normalize 后正文/revision 与新快照完全一致，若直接当作已落盘
   * 会跳过 save，导致 metadata 被更新、bodies/baselines 永远不写。首次 persist
   * 必须 save 一次，让存储层按真实 store 内容拆分或补写缺失 part。
   */
  const unverifiedParts = new Set<string>();
  /** 已落盘记录快照；用于比较 revision，未变化的正文/基线不重复写。 */
  const persistedRecords = new Map<string, FilesTextDraftRecord>();
  /** 仍需要 reconcile 的 storageKey；drain 每次只处理一个并重新核对 desired。 */
  const pendingKeys = new Set<string>();
  let revision = 0;
  let localRevision = 0;
  let lastStamp = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let textTimer: ReturnType<typeof setTimeout> | undefined;
  let draining: Promise<void> | undefined;

  /** 进程内单调 revision；只用于比较同一 storageKey 的正文/基线是否变化。 */
  const nextLocalRevision = (): number => {
    localRevision += 1;
    return localRevision;
  };

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
            persistedRecords.set(storageKey, entry.record);
            // save 已按真实 store 内容完成拆分 / 补写，后续同内容 persist 可跳过。
            unverifiedParts.delete(storageKey);
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
            persistedRecords.delete(storageKey);
            unverifiedParts.delete(storageKey);
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

  interface RuntimeDraftRevisions {
    documentRevision?: number;
    savedDocumentVersionId?: number | null;
  }

  const runtimeRevisions = (state: FilesEditorState): Map<string, RuntimeDraftRevisions> => {
    const revisions = new Map<string, RuntimeDraftRevisions>();
    for (const buffer of state.buffers) {
      if (buffer.kind !== "text") continue;
      revisions.set(buffer.id, {
        documentRevision: buffer.documentRevision,
        savedDocumentVersionId: buffer.savedDocumentVersionId,
      });
    }
    return revisions;
  };

  const sameDraftContent = (left: FilesTextDraftRecord, right: FilesTextDraftRecord): boolean =>
    left.bufferId === right.bufferId &&
    left.path === right.path &&
    left.title === right.title &&
    left.storageKey === right.storageKey &&
    left.workspaceKey === right.workspaceKey &&
    left.remoteSessionId === right.remoteSessionId &&
    left.untitled === right.untitled &&
    left.truncated === right.truncated &&
    left.bodyRevision === right.bodyRevision &&
    left.savedRevision === right.savedRevision &&
    left.text === right.text &&
    left.savedText === right.savedText;

  /**
   * 为正文 / 基线分配单调 revision。
   *
   * 内容未变时复用匹配记录的 revision；内容变化时必须严格大于旧记录，
   * 即使运行时版本号（Monaco versionId）与本地 revision 恰好撞号也不能跳过写入。
   */
  const resolveDraftRevision = (
    records: FilesTextDraftRecord[],
    content: string,
    revisionField: "bodyRevision" | "savedRevision",
    contentField: "text" | "savedText",
    sourceRevision: number | undefined,
  ): number => {
    const matched = records
      .filter((record) => record[contentField] === content)
      .map((record) => record[revisionField]);
    if (matched.length > 0) return Math.max(...matched);
    const previousMax = records.reduce((max, record) => Math.max(max, record[revisionField]), 0);
    return Math.max(nextLocalRevision(), previousMax + 1, sourceRevision ?? 0);
  };

  const persist = (): void => {
    // 显式 persist（保存 / 关闭 / 隐藏）优先：取消尚未触发的输入去抖。
    if (textTimer !== undefined) {
      clearTimeout(textTimer);
      textTimer = undefined;
    }
    const state = store.getState();
    const stamp = nextStamp();
    const session = snapshotFilesEditorSession(state);
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

    const revisionsById = runtimeRevisions(state);
    const nextDesired = new Map<string, DesiredDraft>();
    const nextRevision = ++revision;
    for (const draft of result.overflowDrafts) {
      const runtime = revisionsById.get(draft.id);
      // 运行时 documentRevision 与无文档时的本地 revision 不是同一命名空间；
      // 直接比较可能撞号，导致正文已变但 IDB 认为 revision 未变而跳过写入。
      // 因此内容变化时统一取 max(来源 revision, 旧记录 revision + 1, 本地单调值)，
      // 内容未变时复用匹配记录的 revision，避免无意义重写。
      // 只复用同一 owner 的旧记录；bufferId 不足以证明身份一致。
      const draftWorkspaceKey = filesWorkspaceKey(draft.workspace);
      const draftRemoteSessionId = filesTextDraftRemoteSessionId(draft.workspace);
      const previousRecords = [
        desired.values().find((entry) => entry.record.bufferId === draft.id)?.record,
        persistedRecords.values().find((record) => record.bufferId === draft.id),
      ].filter(
        (record): record is FilesTextDraftRecord =>
          record !== undefined &&
          record.path === draft.path &&
          record.workspaceKey === draftWorkspaceKey &&
          record.remoteSessionId === draftRemoteSessionId,
      );
      const bodyRevision = resolveDraftRevision(
        previousRecords,
        draft.text,
        "bodyRevision",
        "text",
        runtime?.documentRevision,
      );
      const savedRevision = resolveDraftRevision(
        previousRecords,
        draft.savedText,
        "savedRevision",
        "savedText",
        typeof runtime?.savedDocumentVersionId === "number"
          ? runtime.savedDocumentVersionId
          : undefined,
      );
      const record = createFilesTextDraftRecord(draft, draft.updatedAt ?? stamp, {
        bodyRevision,
        savedRevision,
      });
      const previousEntry = desired.get(record.storageKey);
      const previous = previousEntry?.record;
      const persisted = persistedRecords.get(record.storageKey);
      // 内容未变时保留已落盘 epoch，避免仅因一次 persist 把旧记录伪装成更新版本。
      const unchanged =
        persisted && sameDraftContent(persisted, record)
          ? persisted
          : previous && sameDraftContent(previous, record)
            ? previous
            : undefined;
      // 内容没变时沿用旧 desired revision，避免在途 save 完成后又触发一次相同写入。
      const contentUnchanged =
        previousEntry !== undefined && sameDraftContent(previousEntry.record, unchanged ?? record);
      nextDesired.set(record.storageKey, {
        record: unchanged ?? record,
        revision: contentUnchanged && previousEntry ? previousEntry.revision : nextRevision,
      });
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
      const persisted = persistedRecords.get(storageKey);
      // load 命中的记录也必须在首次 persist 时 save 一次：整条可读不等于三 store
      // 已拆分，v2 记录的内容/revision 可能与新快照完全相同，只看内容会永久跳过拆分。
      if (
        unverifiedParts.has(storageKey) ||
        !persisted ||
        !sameDraftContent(persisted, entry.record)
      ) {
        pendingKeys.add(storageKey);
      }
    }
    if (pendingKeys.size > 0) schedule();
  };

  const noteTextChange = (): void => {
    if (textPersistDebounceMs <= 0) {
      persist();
      return;
    }
    // 逐键路径只重置计时器：不读正文、不 snapshot、不 JSON.stringify、不写存储。
    // 保存 await 期间若继续输入，这里的去抖 persist 是独立备份边界：
    // commit snapshot 早于新输入，不能复用；停掉它会在长保存 / 崩溃时丢草稿。
    if (textTimer !== undefined) clearTimeout(textTimer);
    textTimer = setTimeout(() => {
      textTimer = undefined;
      persist();
    }, textPersistDebounceMs);
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
      // 这次 load 只证明整条记录可读，尚未证明 v3 三 store 已拆分 / part 存在。
      unverifiedParts.add(storageKey);
      if (
        localDraft &&
        (localDraft.updatedAt === undefined || localDraft.updatedAt >= record.updatedAt)
      ) {
        // localStorage 是同步基线：本地缺 epoch 或 epoch 不早于 IndexedDB 时本地胜出。
        persistedKeys.add(storageKey);
        persistedRecords.set(storageKey, record);
        if (!desired.has(storageKey)) {
          pendingKeys.add(storageKey);
          schedule();
        }
        continue;
      }
      // IndexedDB 是更新版本（如 localStorage 写失败保留旧会话），或本地只有标签元数据。
      persistedKeys.add(storageKey);
      persistedRecords.set(storageKey, record);
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
    // 关闭 / 隐藏前的 flush 必须把尚未触发的输入去抖立即落成快照。
    if (textTimer !== undefined) {
      clearTimeout(textTimer);
      textTimer = undefined;
      persist();
    }
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    await drain();
  };

  return { persist, noteTextChange, load, flush };
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
