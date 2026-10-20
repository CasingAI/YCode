import { useCallback, useMemo } from "react";
import {
  findFilesExplorerWorkspaceOption,
  type FilesExplorerWorkspaceOption,
} from "@/files-workbench/filesExplorerWorkspace.js";
import { resolveExplorerWorkspaceKey } from "@/files-workbench/filesEditorModel.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";

/**
 * 新建未命名文件：需要一个确定的工作区，优先用资源管理器里选中的那个。
 */
export function useFilesEditorUntitled(options: {
  store: FilesEditorStore;
  explorerOptions: readonly FilesExplorerWorkspaceOption[];
  explorerWorkspaceKey: string | undefined;
  persist: () => void;
  /**
   * 新建后切到文件界面。
   * 应用菜单的「新建文件」在任务 / 设置界面同样可用，
   * 新建的标签必须立刻可见，否则用户看不到自己刚建的文件。
   */
  openFilesView?: () => void;
}) {
  const { store, explorerOptions, explorerWorkspaceKey, persist, openFilesView } = options;

  const untitledWorkspace = useMemo(() => {
    const selectedKey = resolveExplorerWorkspaceKey({
      preferredKey: explorerWorkspaceKey,
      workspaceKeys: explorerOptions.map((option) => option.key),
    });
    return findFilesExplorerWorkspaceOption(explorerOptions, selectedKey)?.workspace;
  }, [explorerOptions, explorerWorkspaceKey]);

  const onCreateUntitled = useCallback(() => {
    if (!untitledWorkspace) return;
    store.getState().createUntitled(untitledWorkspace);
    persist();
    openFilesView?.();
  }, [openFilesView, persist, store, untitledWorkspace]);

  return { untitledWorkspace, onCreateUntitled };
}
