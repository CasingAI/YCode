import { useCallback, useEffect, useState } from "react";
import { UiCommandIds, type UiCommandId } from "@zcode/shared";
import { useAppKeyboard } from "@/hooks/useAppKeyboard.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { CLOSE_ACTIVE_EDITOR_REQUEST_EVENT } from "@/lib/closeActiveEditor.js";
import {
  registerEditCommandTarget,
  setEditCommandTargetFocused,
  type EditCommandTarget,
} from "@/shortcuts/editCommandTarget.js";
import type { FilesEditorStatusHandle } from "@/files-workbench/filesMonacoStatusHandle.js";
import { useFilesEditorStoreApi } from "@/files-workbench/FilesEditorStoreProvider.js";
import { resolveFilesEditorMenuState } from "@/files-workbench/filesEditorMenuContext.js";
import { executeFilesEditorFileCommand } from "@/files-workbench/filesEditorFileCommands.js";
import { executeEditMenuCommand } from "@/shortcuts/editMenuCommand.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { resolveWorkspaceShellPrimaryView } from "@/store/tabStore.js";

interface EditorHandleBinding {
  bufferId: string;
  handle: FilesEditorStatusHandle;
}

/**
 * 文件工作台与桌面菜单 / 快捷键的接线。
 *
 * 四条入口最终命中同一批动作：
 * - 菜单下发的渲染进程命令（保存、另存为、全部保存、新建文件）；
 * - 各平台可点击的工作台文件 / 编辑菜单；
 * - 统一快捷键分发（保存类命令可以在设置里改键）；
 * - 关闭当前聚焦编辑器组的活动标签（三个桌面平台统一的关闭快捷键）。
 *
 * 撤销 / 重做 / 查找由共用编辑命令路由处理，
 * 编辑目标注册表（editCommandTarget）按「操作前的编辑焦点」决定作用对象。
 */
export function useFilesEditorMenuCommands(options: {
  isActiveView: boolean;
  /** 当前聚焦编辑器组；撤销 / 重做 / 查找要作用到它。 */
  focusedGroupId: string | undefined;
  activeBufferId: string | undefined;
  canCreateFile: boolean;
  saveActiveFile: () => Promise<boolean>;
  saveActiveFileAs: () => boolean;
  saveAllFiles: () => Promise<void>;
  onCreateUntitled: () => void;
  closeActiveEditorView: () => boolean;
}) {
  const {
    isActiveView,
    focusedGroupId,
    activeBufferId,
    canCreateFile,
    saveActiveFile,
    saveActiveFileAs,
    saveAllFiles,
    onCreateUntitled,
    closeActiveEditorView,
  } = options;
  const platform = usePlatform();
  const store = useFilesEditorStoreApi();
  const tabStore = useTabStoreApi();
  // 各编辑器组的编辑器句柄：菜单的撤销/重做/查找按聚焦组定位编辑器。
  const [editorHandles, setEditorHandles] = useState<ReadonlyMap<string, EditorHandleBinding>>(
    new Map(),
  );

  // 编辑器句柄按组登记：组切换、句柄重建时都能定位到当前聚焦组的编辑器。
  const onEditorHandleChange = useCallback(
    (groupId: string, handle: FilesEditorStatusHandle | null, bufferId?: string) => {
      setEditorHandles((current) => {
        if (!handle) {
          if (!current.has(groupId)) {
            return current;
          }
          const next = new Map(current);
          next.delete(groupId);
          return next;
        }
        if (!bufferId) return current;
        if (
          current.get(groupId)?.handle === handle &&
          current.get(groupId)?.bufferId === bufferId
        ) {
          return current;
        }
        const next = new Map(current);
        next.set(groupId, { bufferId, handle });
        return next;
      });
    },
    [],
  );

  // 桌面菜单的撤销/重做/查找：作用对象由「操作前的编辑焦点」决定，
  // 这里登记聚焦组的编辑器，并跟踪它的焦点变化：
  // 编辑器拿到焦点时把它记为最近聚焦目标，菜单点击导致失焦时也不会丢掉目标。
  const focusedBinding = focusedGroupId ? editorHandles.get(focusedGroupId) : undefined;
  // 组切换标签后旧句柄可能还没清理，必须同时匹配缓冲身份才能作为菜单目标。
  const focusedEditorHandle =
    focusedBinding?.bufferId === activeBufferId ? focusedBinding?.handle : undefined;
  useEffect(() => {
    if (!isActiveView || !focusedEditorHandle) {
      return;
    }
    const target: EditCommandTarget = {
      kind: "editor",
      isFocused: () => focusedEditorHandle.hasFocus(),
      undo: () => focusedEditorHandle.undo(),
      redo: () => focusedEditorHandle.redo(),
      find: (options) => focusedEditorHandle.find(options),
    };
    const disposeTarget = registerEditCommandTarget(target);
    const unsubscribeFocus = focusedEditorHandle.subscribeFocus((focused) => {
      setEditCommandTargetFocused(target, focused);
    });
    if (focusedEditorHandle.hasFocus()) {
      setEditCommandTargetFocused(target, true);
    }
    return () => {
      unsubscribeFocus();
      disposeTarget();
    };
  }, [focusedEditorHandle, isActiveView]);

  const readCommandContext = useCallback(() => {
    const tabs = tabStore.getState();
    return {
      isActiveView:
        resolveWorkspaceShellPrimaryView(tabs.tabs.find((tab) => tab.id === tabs.activeTabId)) ===
        "files",
      canCreateFile,
      editor: resolveFilesEditorMenuState(store.getState()),
    };
  }, [canCreateFile, store, tabStore]);
  const executeFileCommand = useCallback(
    (command: UiCommandId) =>
      executeFilesEditorFileCommand(command, readCommandContext(), {
        saveActiveFile,
        saveActiveFileAs,
        saveAllFiles,
        onCreateUntitled,
      }),
    [onCreateUntitled, readCommandContext, saveActiveFile, saveActiveFileAs, saveAllFiles],
  );
  const onMenuCommand = useCallback(
    (command: UiCommandId) => {
      // 工作台入口只属于当前文件视图；全局新建仍由原生菜单/快捷键直接走文件命令分派。
      if (!readCommandContext().isActiveView) return;
      if (executeFileCommand(command)) return;
      const context = readCommandContext();
      const current = store.getState();
      const binding = current.layout.focusedGroupId
        ? editorHandles.get(current.layout.focusedGroupId)
        : undefined;
      // disabled 只是投影；执行时再核对当前视图与句柄身份，防止保活/只读标签误改旧文本。
      if (
        !context.isActiveView ||
        !context.editor.canSave ||
        !binding ||
        binding.bufferId !== current.activeId
      )
        return;
      executeEditMenuCommand(command, "files");
    },
    [editorHandles, executeFileCommand, readCommandContext, store],
  );
  const onCloseEditor = useCallback(() => {
    const context = readCommandContext();
    if (context.isActiveView && context.editor.hasActiveEditor) closeActiveEditorView();
  }, [closeActiveEditorView, readCommandContext]);

  // 保存类快捷键走统一快捷键分发（useAppKeyboard），不再单独监听裸 ⌘S：
  // 这样键位可以在设置里改，菜单与按键也命中同一条写盘路径。
  // 新建文件在任何界面都可用：它会切到文件界面，因此不受 isActiveView 限制。
  useAppKeyboard({
    saveFile: isActiveView ? () => void executeFileCommand(UiCommandIds.SaveFile) : null,
    saveFileAs: isActiveView ? () => void executeFileCommand(UiCommandIds.SaveFileAs) : null,
    saveAllFiles: isActiveView ? () => void executeFileCommand(UiCommandIds.SaveAllFiles) : null,
    newFile: () => void executeFileCommand(UiCommandIds.NewFile),
  });

  // 桌面菜单下发的渲染进程命令：保存、另存为、全部保存、新建文件。
  // 保存类只在文件界面有对象（菜单项也只在文件界面出现），这里再按 isActiveView 兜一层，
  // 避免过期菜单点击落到别的界面。
  useEffect(() => {
    if (!platform.onExecuteUiCommand) {
      return;
    }
    return platform.onExecuteUiCommand((command) => {
      // 编辑命令由 root 的共用路由消费，这里只处理文件命令，避免一次菜单动作执行两遍。
      executeFileCommand(command);
    });
  }, [executeFileCommand, platform]);

  // 关闭快捷键（三个桌面平台一致）：只关闭当前聚焦编辑器组的活动标签，
  // 不回落为关侧栏标签或关闭窗口。非文件界面不注册监听，请求就是空操作。
  useEffect(() => {
    if (!isActiveView) {
      return;
    }
    const handleCloseActiveEditorRequest = () => {
      onCloseEditor();
    };
    window.addEventListener(CLOSE_ACTIVE_EDITOR_REQUEST_EVENT, handleCloseActiveEditorRequest);
    return () => {
      window.removeEventListener(CLOSE_ACTIVE_EDITOR_REQUEST_EVENT, handleCloseActiveEditorRequest);
    };
  }, [isActiveView, onCloseEditor]);

  return {
    onEditorHandleChange,
    onMenuCommand,
    onCloseEditor,
    canEdit: Boolean(isActiveView && focusedEditorHandle),
  };
}
