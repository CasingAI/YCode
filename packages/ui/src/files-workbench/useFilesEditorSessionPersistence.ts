import { useCallback, useEffect, useRef } from "react";
import {
  createFilesEditorSessionPersistence,
  registerFilesEditorSessionPersistence,
  type FilesEditorSessionPersistence,
} from "@/files-workbench/filesEditorSessionPersistenceOwner.js";
import type { FilesPersistedSession } from "@/files-workbench/filesEditorTypes.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";

/**
 * 文件工作台会话持久化的 hook 接线。
 *
 * 状态 owner 仍是 Files Editor Store；这里只创建唯一的持久化 owner、
 * 注册给文件树等非 hook 入口，并在页面隐藏 / 卸载前同步写入 localStorage、
 * 启动 best-effort IndexedDB flush。
 */
export function useFilesEditorSessionPersistence(store: FilesEditorStore): {
  persist: () => void;
  load: () => Promise<FilesPersistedSession | undefined>;
} {
  const persistenceRef = useRef<FilesEditorSessionPersistence | undefined>(undefined);
  if (!persistenceRef.current) {
    persistenceRef.current = createFilesEditorSessionPersistence({ store });
  }
  const persistence = persistenceRef.current;

  const persist = useCallback(() => {
    persistence.persist();
  }, [persistence]);

  useEffect(() => {
    // 文件树改名 / 删除等非 hook 入口通过注册表复用同一持久化 owner。
    return registerFilesEditorSessionPersistence(store, persistence);
  }, [persistence, store]);

  useEffect(() => {
    // 逐键只订阅正文代次；owner 去抖后才 snapshot，不把 getValue 放回输入路径。
    return store.subscribe((state, previous) => {
      if (state.textChangeEpoch !== previous.textChangeEpoch) {
        persistence.noteTextChange();
      }
    });
  }, [persistence, store]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // 浏览器不保证异步 IndexedDB 在卸载前完成：persist 只保证同步写 localStorage，
    // flush 只是提前启动的 best-effort，不添加超时掩盖竞态，也不承诺异步落盘成功。
    const flushBeforeHide = () => {
      persistence.persist();
      void persistence.flush();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushBeforeHide();
    };
    window.addEventListener("pagehide", flushBeforeHide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flushBeforeHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [persistence]);

  return { persist, load: persistence.load };
}
