import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { DesktopMenuContext } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { resolveWorkspaceShellPrimaryView } from "@/store/tabStore.js";
import { useFilesEditorStore } from "@/files-workbench/FilesEditorStoreProvider.js";
import { resolveFilesEditorMenuState } from "@/files-workbench/filesEditorMenuContext.js";

/**
 * 把当前界面的菜单上下文投影同步给主进程。
 *
 * macOS 的应用菜单全局只有一份，条目显隐只能由主进程按焦点窗口的投影驱动，
 * 所以渲染进程必须主动上报。投影只含标量（布尔量与计数），没有变化就不重复同步，
 * 避免每次击键都跨进程发一遍。
 */
export function useDesktopMenuContextSync(): void {
  const platform = usePlatform();
  const primaryView = useTabStore((state) =>
    resolveWorkspaceShellPrimaryView(
      state.tabs.find((candidate) => candidate.id === state.activeTabId),
    ),
  );
  // 投影只取标量：useShallow 保证值没变时引用不变，
  // 于是「数组引用变了但内容没变」（例如每次击键重建的 buffers）不会触发同步。
  const editorState = useFilesEditorStore(
    useShallow((state) => resolveFilesEditorMenuState(state)),
  );

  const context = useMemo<DesktopMenuContext>(() => {
    if (primaryView !== "files") {
      return { view: primaryView, editor: null };
    }
    return {
      view: primaryView,
      editor: editorState,
    };
  }, [editorState, primaryView]);

  useEffect(() => {
    platform.syncMenuContext?.(context);
  }, [context, platform]);
}
