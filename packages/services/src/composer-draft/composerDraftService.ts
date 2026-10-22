import { Emitter } from "@zcode/rpc";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  ComposerDraftChange,
  ComposerDraftRecord,
  ComposerDraftScope,
  IComposerDraftService,
} from "./composerDraft.js";

const logger = createServiceLogger("composerDraft");

/** 落盘的一条草稿。`payload` 的结构由调用方定义，服务只搬运。 */
export interface StoredComposerDraft {
  payload: unknown;
  updatedAt: number;
  clientId: string;
}

/**
 * 草稿的持久化后端。
 *
 * 服务本身不关心草稿落在哪：桌面 Host 落用户数据目录，测试落内存。
 */
export interface ComposerDraftStore {
  read(scope: ComposerDraftScope): Promise<StoredComposerDraft | null>;
  write(scope: ComposerDraftScope, draft: StoredComposerDraft): Promise<void>;
  remove(scope: ComposerDraftScope): Promise<void>;
}

function scopeKey(scope: ComposerDraftScope): string {
  return `${scope.workspaceKey}\0${scope.scopeId}`;
}

/** 落盘去抖窗口（毫秒）。 */
const PERSIST_DEBOUNCE_MS = 800;

/**
 * 共享草稿服务。
 *
 * 桌面窗口与手机远控端连的是同一个 Host，服务实例因此只有一份：
 * 两端读到的是同一条记录，写入也是同一份存储，不需要额外的同步协议。
 *
 * 冲突裁决是"最后写入者赢"，但服务只负责定序与广播：
 * 是否把远端版本应用到本地编辑器由调用方判断（本地还有未保存输入时不能覆盖）。
 */
export function createComposerDraftService(options: {
  store: ComposerDraftStore;
  now?: () => number;
}): IComposerDraftService {
  const now = options.now ?? (() => Date.now());
  const changed = new Emitter<ComposerDraftChange>();
  const cache = new Map<string, StoredComposerDraft>();
  const loaded = new Set<string>();
  // 落盘去抖：输入停顿期间会连续写同一份草稿，落盘只需要跟上最后一份。
  // 内存副本与变更事件是即时的，另一端因此能立刻看到，不受去抖影响。
  const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const persistWaiters = new Map<string, Array<() => void>>();

  function schedulePersist(
    scope: ComposerDraftScope,
    stored: StoredComposerDraft,
  ): Promise<void> {
    const key = scopeKey(scope);
    const previous = persistTimers.get(key);
    if (previous) {
      clearTimeout(previous);
    }
    return new Promise<void>((resolve) => {
      const waiters = persistWaiters.get(key) ?? [];
      waiters.push(resolve);
      persistWaiters.set(key, waiters);
      persistTimers.set(
        key,
        setTimeout(() => {
          persistTimers.delete(key);
          const pending = persistWaiters.get(key) ?? [];
          persistWaiters.delete(key);
          void options.store
            .write(scope, stored)
            .catch((error) => {
              logger.warn(undefined, "persist composer draft failed:", error);
            })
            .finally(() => {
              for (const waiter of pending) {
                waiter();
              }
            });
        }, PERSIST_DEBOUNCE_MS),
      );
    });
  }

  function cancelPendingPersist(scope: ComposerDraftScope): void {
    const key = scopeKey(scope);
    const timer = persistTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      persistTimers.delete(key);
    }
    const waiters = persistWaiters.get(key) ?? [];
    persistWaiters.delete(key);
    for (const waiter of waiters) {
      waiter();
    }
  }
  async function ensureLoaded(scope: ComposerDraftScope): Promise<void> {
    const key = scopeKey(scope);
    if (loaded.has(key)) {
      return;
    }
    loaded.add(key);
    try {
      const stored = await options.store.read(scope);
      if (stored) {
        cache.set(key, stored);
      }
    } catch (error) {
      logger.warn(undefined, "read composer draft failed:", error);
    }
  }

  return {
    async getDraft(scope) {
      await ensureLoaded(scope);
      const stored = cache.get(scopeKey(scope));
      if (!stored) {
        return null;
      }
      return {
        workspaceKey: scope.workspaceKey,
        scopeId: scope.scopeId,
        payload: stored.payload,
        updatedAt: stored.updatedAt,
        clientId: stored.clientId,
      };
    },

    async putDraft({ workspaceKey, scopeId, payload, clientId }) {
      const scope = { workspaceKey, scopeId };
      await ensureLoaded(scope);
      const stored: StoredComposerDraft = {
        payload,
        updatedAt: now(),
        clientId,
      };
      cache.set(scopeKey(scope), stored);
      // 落盘失败只影响跨重启保留：内存里已经是最新的一份，
      // 同 Host 的另一端照样能读到，不能因此把写入回滚。
      await schedulePersist(scope, stored);
      const record: ComposerDraftRecord = {
        workspaceKey,
        scopeId,
        payload: stored.payload,
        updatedAt: stored.updatedAt,
        clientId,
      };
      changed.fire({ workspaceKey, scopeId, record });
      return record;
    },

    async clearDraft(scope) {
      await ensureLoaded(scope);
      cache.delete(scopeKey(scope));
      // 清除必须先撤掉待落盘的写入：否则被撤掉的那一版会在清除之后又写回去。
      cancelPendingPersist(scope);
      try {
        await options.store.remove(scope);
      } catch (error) {
        logger.warn(undefined, "remove composer draft failed:", error);
      }
      changed.fire({
        workspaceKey: scope.workspaceKey,
        scopeId: scope.scopeId,
        record: null,
      });
    },

    onDidChangeDraft: changed.event,
  };
}

/** 内存实现：单测与无持久化场景使用。 */
export function createMemoryComposerDraftStore(
  initial: StoredComposerDraft | null = null,
): ComposerDraftStore {
  let current = initial;
  return {
    read: async () => current,
    write: async (_scope, draft) => {
      current = draft;
    },
    remove: async () => {
      current = null;
    },
  };
}
