/**
 * 应用菜单条目的稳定 id。
 *
 * id 跨界面切换不变，主进程靠它原地改 visible / enabled，不必重建菜单；
 * 分隔线也是菜单项，必须与相邻条目一起显隐，否则会留下孤立分隔线。
 *
 * 本文件只放常量，不依赖 electron：菜单模板、菜单上下文投影与测试都从这里取同一份 id。
 */
export const DESKTOP_MENU_ITEM_IDS = {
  fileNewTask: "file.new-task",
  fileNewFile: "file.new-file",
  fileOpenWorkspace: "file.open-workspace",
  fileSave: "file.save",
  fileSaveAs: "file.save-as",
  fileSaveAll: "file.save-all",
  fileCloseEditor: "file.close-editor",
  fileCloseWindow: "file.close-window",
  fileSeparatorSave: "file.separator.save",
  fileSeparatorClose: "file.separator.close",
  editUndo: "edit.undo",
  editRedo: "edit.redo",
  editFind: "edit.find",
  editFindReplace: "edit.find-replace",
  editSeparatorFind: "edit.separator.find",
  windowCloseWindow: "window.close-window",
} as const;

/** 只在文件界面出现的条目 id（连同它们专属的分隔线）。 */
export const DESKTOP_MENU_FILES_ONLY_ITEM_IDS: readonly string[] = [
  DESKTOP_MENU_ITEM_IDS.fileSeparatorSave,
  DESKTOP_MENU_ITEM_IDS.fileSave,
  DESKTOP_MENU_ITEM_IDS.fileSaveAs,
  DESKTOP_MENU_ITEM_IDS.fileSaveAll,
  DESKTOP_MENU_ITEM_IDS.fileSeparatorClose,
  DESKTOP_MENU_ITEM_IDS.fileCloseEditor,
  DESKTOP_MENU_ITEM_IDS.editSeparatorFind,
  DESKTOP_MENU_ITEM_IDS.editFind,
  DESKTOP_MENU_ITEM_IDS.editFindReplace,
];

/** 「检查更新」条目 id（更新器负责状态，菜单模板只负责位置）。 */
export const CHECK_FOR_UPDATE_MENU_ID = "check-for-update";

/** 「切换开发者工具」条目 id。 */
export const HELP_TOGGLE_DEV_TOOLS_MENU_ID = "help.toggle-dev-tools";

/** 「抓取 Agent stdio 通信」条目 id。 */
export const HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID = "help.toggle-zcode-stdio-tap";
