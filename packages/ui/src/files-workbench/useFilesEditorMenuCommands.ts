import { useCallback, useEffect, useState } from "react";
import { UiCommandIds } from "@zcode/shared";
import { useAppKeyboard } from "@/hooks/useAppKeyboard.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { CLOSE_ACTIVE_EDITOR_REQUEST_EVENT } from "@/lib/closeActiveContext.js";
import {
  registerEditCommandTarget,
  setEditCommandTargetFocused,
  type EditCommandTarget,
} from "@/shortcuts/editCommandTarget.js";
import type { FilesEditorStatusHandle } from "@/files-workbench/filesMonacoStatusHandle.js";

/**
 * 文件工作台与桌面菜单 / 快捷键的接线。
 *
 * 三条入口最终命中同一批动作：
 * - 菜单下发的渲染进程命令（保存、另存为、全部保存、新建文件）；
 * - 统一快捷键分发（保存类命令可以在设置里改键）；
 * - macOS 的 ⌘W 关闭当前聚焦编辑器组的活动标签。
 *
 * 撤销 / 重做 / 查找不在这条链路上：它们按「操作前的编辑焦点」路由，
 * 由编辑目标注册表（editCommandTarget）决定作用对象。
 */
export function useFilesEditorMenuCommands(options: {
  isActiveView: boolean;
  /** 当前聚焦编辑器组；撤销 / 重做 / 查找要作用到它。 */
  focusedGroupId: string | undefined;
  saveActiveFile: () => Promise<boolean>;
  saveActiveFileAs: () => boolean;
  saveAllFiles: () => Promise<void>;
  onCreateUntitled: () => void;
  closeActiveEditorView: () => boolean;
}) {
  const {
    isActiveView,
    focusedGroupId,
    saveActiveFile,
    saveActiveFileAs,
    saveAllFiles,
    onCreateUntitled,
    closeActiveEditorView,
  } = options;
  const platform = usePlatform();
  // 各编辑器组的编辑器句柄：菜单的撤销/重做/查找按聚焦组定位编辑器。
  const [editorHandles, setEditorHandles] = useState<ReadonlyMap<string, FilesEditorStatusHandle>>(
    new Map(),
  );

  // 编辑器句柄按组登记：组切换、句柄重建时都能定位到当前聚焦组的编辑器。
  const onEditorHandleChange = useCallback(
    (groupId: string, handle: FilesEditorStatusHandle | null) => {
      setEditorHandles((current) => {
        if (!handle) {
          if (!current.has(groupId)) {
            return current;
          }
          const next = new Map(current);
          next.delete(groupId);
          return next;
        }
        if (current.get(groupId) === handle) {
          return current;
        }
        const next = new Map(current);
        next.set(groupId, handle);
        return next;
      });
    },
    [],
  );

  // 桌面菜单的撤销/重做/查找：作用对象由「操作前的编辑焦点」决定，
  // 这里登记聚焦组的编辑器，并跟踪它的焦点变化：
  // 编辑器拿到焦点时把它记为最近聚焦目标，菜单点击导致失焦时也不会丢掉目标。
  const focusedEditorHandle = focusedGroupId ? editorHandles.get(focusedGroupId) : undefined;
  useEffect(() => {
    if (!focusedEditorHandle) {
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
  }, [focusedEditorHandle]);

  // 保存类快捷键走统一快捷键分发（useAppKeyboard），不再单独监听裸 ⌘S：
  // 这样键位可以在设置里改，菜单与按键也命中同一条写盘路径。
  // 新建文件在任何界面都可用：它会切到文件界面，因此不受 isActiveView 限制。
  useAppKeyboard({
    saveFile: isActiveView ? () => void saveActiveFile() : null,
    saveFileAs: isActiveView ? () => void saveActiveFileAs() : null,
    saveAllFiles: isActiveView ? () => void saveAllFiles() : null,
    newFile: onCreateUntitled,
  });

  // 桌面菜单下发的渲染进程命令：保存、另存为、全部保存、新建文件。
  // 保存类只在文件界面有对象（菜单项也只在文件界面出现），这里再按 isActiveView 兜一层，
  // 避免过期菜单点击落到别的界面。
  useEffect(() => {
    if (!platform.onExecuteUiCommand) {
      return;
    }
    return platform.onExecuteUiCommand((command) => {
      switch (command) {
        case UiCommandIds.SaveFile:
          if (!isActiveView) break;
          void saveActiveFile();
          break;
        case UiCommandIds.SaveFileAs:
          if (!isActiveView) break;
          void saveActiveFileAs();
          break;
        case UiCommandIds.SaveAllFiles:
          if (!isActiveView) break;
          void saveAllFiles();
          break;
        case UiCommandIds.NewFile:
          // 新建文件自带「切到文件界面」，任何界面都能用。
          onCreateUntitled();
          break;
        default:
          break;
      }
    });
  }, [isActiveView, onCreateUntitled, platform, saveActiveFile, saveActiveFileAs, saveAllFiles]);

  // macOS 的 ⌘W：只关闭当前聚焦编辑器组的活动标签，不回落为关闭窗口。
  useEffect(() => {
    if (!isActiveView) {
      return;
    }
    const handleCloseActiveEditorRequest = () => {
      closeActiveEditorView();
    };
    window.addEventListener(CLOSE_ACTIVE_EDITOR_REQUEST_EVENT, handleCloseActiveEditorRequest);
    return () => {
      window.removeEventListener(CLOSE_ACTIVE_EDITOR_REQUEST_EVENT, handleCloseActiveEditorRequest);
    };
  }, [closeActiveEditorView, isActiveView]);

  return { onEditorHandleChange };
}
