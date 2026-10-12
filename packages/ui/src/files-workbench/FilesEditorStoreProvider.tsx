import { createContext, useContext, useRef, type ReactNode } from "react";
import { useStore } from "zustand";
import {
  createFilesEditorStore,
  type FilesEditorStore,
  type FilesEditorStoreState,
} from "@/files-workbench/filesEditorStore.js";

const FilesEditorStoreContext = createContext<FilesEditorStore | undefined>(undefined);

export function FilesEditorStoreProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<FilesEditorStore | undefined>(undefined);
  if (!storeRef.current) {
    storeRef.current = createFilesEditorStore();
  }
  return (
    <FilesEditorStoreContext.Provider value={storeRef.current}>
      {children}
    </FilesEditorStoreContext.Provider>
  );
}

export function useFilesEditorStore<T>(selector: (state: FilesEditorStoreState) => T): T {
  const store = useContext(FilesEditorStoreContext);
  if (!store) {
    throw new Error("useFilesEditorStore 必须在 FilesEditorStoreProvider 内使用");
  }
  return useStore(store, selector);
}

export function useFilesEditorStoreApi(): FilesEditorStore {
  const store = useContext(FilesEditorStoreContext);
  if (!store) {
    throw new Error("useFilesEditorStoreApi 必须在 FilesEditorStoreProvider 内使用");
  }
  return store;
}
