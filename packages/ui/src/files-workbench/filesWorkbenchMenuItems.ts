import {
  UiCommandIds,
  desktopMenuMessageIds,
  type DesktopMenuEditorState,
  type DesktopMenuMessageId,
  type ShortcutCommandId,
  type UiCommandId,
} from "@zcode/shared";

export interface FilesWorkbenchMenuItem {
  messageId: DesktopMenuMessageId;
  command?: UiCommandId;
  shortcutId?: ShortcutCommandId;
  disabled: boolean;
  separatorBefore?: boolean;
}

/** 菜单只消费工作台能力投影；缓冲、写盘及编辑目标仍由既有控制器拥有。 */
export function buildFilesWorkbenchMenuItems({
  state,
  canEdit,
  canCreateFile,
}: {
  state: DesktopMenuEditorState;
  canEdit: boolean;
  canCreateFile: boolean;
}): { file: FilesWorkbenchMenuItem[]; edit: FilesWorkbenchMenuItem[] } {
  return {
    file: [
      {
        messageId: desktopMenuMessageIds.fileNewFile,
        command: UiCommandIds.NewFile,
        shortcutId: "newFile",
        disabled: !canCreateFile,
      },
      {
        messageId: desktopMenuMessageIds.fileSave,
        command: UiCommandIds.SaveFile,
        shortcutId: "saveFile",
        disabled: !state.canSave,
        separatorBefore: true,
      },
      {
        messageId: desktopMenuMessageIds.fileSaveAs,
        command: UiCommandIds.SaveFileAs,
        shortcutId: "saveFileAs",
        disabled: !state.canSave,
      },
      {
        messageId: desktopMenuMessageIds.fileSaveAll,
        command: UiCommandIds.SaveAllFiles,
        shortcutId: "saveAllFiles",
        disabled: state.dirtyFileCount === 0,
      },
      {
        messageId: desktopMenuMessageIds.fileCloseEditor,
        shortcutId: "closeActiveContext",
        disabled: !state.hasActiveEditor,
        separatorBefore: true,
      },
    ],
    edit: [
      {
        messageId: desktopMenuMessageIds.editUndo,
        command: UiCommandIds.Undo,
        disabled: !canEdit,
      },
      {
        messageId: desktopMenuMessageIds.editRedo,
        command: UiCommandIds.Redo,
        disabled: !canEdit,
      },
      {
        messageId: desktopMenuMessageIds.editFind,
        command: UiCommandIds.FindInEditor,
        shortcutId: "findInTask",
        disabled: !canEdit,
        separatorBefore: true,
      },
      {
        messageId: desktopMenuMessageIds.editFindReplace,
        command: UiCommandIds.FindReplaceInEditor,
        shortcutId: "findReplaceInEditor",
        disabled: !canEdit,
      },
    ],
  };
}
