import { UiCommandIds, type DesktopMenuEditorState, type UiCommandId } from "@zcode/shared";

/** 文件菜单、原生菜单与快捷键共用命令准入，不持有缓冲或执行文件 IO。 */
export function executeFilesEditorFileCommand(
  command: UiCommandId,
  context: {
    isActiveView: boolean;
    canCreateFile: boolean;
    editor: DesktopMenuEditorState;
  },
  actions: {
    saveActiveFile: () => Promise<boolean>;
    saveActiveFileAs: () => boolean;
    saveAllFiles: () => Promise<void>;
    onCreateUntitled: () => void;
  },
): boolean {
  if (command === UiCommandIds.NewFile) {
    if (!context.canCreateFile) return false;
    actions.onCreateUntitled();
    return true;
  }

  // 文件视图会保活；菜单显示过的可用状态不能授权切走后到达的保存命令。
  if (!context.isActiveView) return false;

  switch (command) {
    case UiCommandIds.SaveFile:
      if (!context.editor.canSave) return false;
      // 未命名保存返回 false 表示等待另存为；动作已经接收，不能据此重复分派。
      void actions.saveActiveFile();
      return true;
    case UiCommandIds.SaveFileAs:
      if (!context.editor.canSave) return false;
      actions.saveActiveFileAs();
      return true;
    case UiCommandIds.SaveAllFiles:
      if (context.editor.dirtyFileCount <= 0) return false;
      void actions.saveAllFiles();
      return true;
    default:
      return false;
  }
}
