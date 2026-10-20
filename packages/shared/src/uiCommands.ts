/**
 * 渲染进程命令 id —— 主进程下发给渲染进程、由渲染进程执行的一组命令。
 *
 * 与 `DesktopCommandIds` 的分工：
 * - `DesktopCommandIds` 是主进程能自己完成的动作（开窗口、缩放、退出…）；
 * - 这里的命令必须由渲染进程执行（保存文件、关闭编辑器、查找…），主进程只负责转发。
 *
 * 与 `ShortcutCommandId` 的分工：
 * - `ShortcutCommandId` 描述「用户按了哪个键」，是快捷键表的条目；
 * - 这里的 id 描述「要做什么」，菜单点击与快捷键最终都落到同一批命令上。
 */

/** 渲染进程命令 id。 */
export const UiCommandIds = {
  /** 保存当前文件。 */
  SaveFile: "saveFile",
  /** 另存为当前文件。 */
  SaveFileAs: "saveFileAs",
  /** 保存所有未保存的文件。 */
  SaveAllFiles: "saveAllFiles",
  /** 新建未命名文件。 */
  NewFile: "newFile",
  /** 撤销：作用于失焦前的编辑目标。 */
  Undo: "undo",
  /** 重做：作用于失焦前的编辑目标。 */
  Redo: "redo",
  /** 在代码编辑器里查找。 */
  FindInEditor: "findInEditor",
  /** 在代码编辑器里查找替换。 */
  FindReplaceInEditor: "findReplaceInEditor",
} as const;

export type UiCommandId = (typeof UiCommandIds)[keyof typeof UiCommandIds];

/** 命令 id 白名单。跨进程传输前必须过这一关，避免主进程下发未知命令。 */
const UI_COMMAND_IDS = Object.values(UiCommandIds) as readonly UiCommandId[];

export function isUiCommandId(value: unknown): value is UiCommandId {
  return typeof value === "string" && (UI_COMMAND_IDS as readonly string[]).includes(value);
}
