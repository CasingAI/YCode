import type { BrowserWindow } from "electron";
import {
  DesktopCommandIds,
  desktopMenuMessageIds,
  UiCommandIds,
  type DesktopCommandId,
  type Locale,
  type UiCommandId,
} from "@zcode/shared";
import { DESKTOP_MENU_ITEM_IDS } from "./desktopMenuItems.js";
import { getDesktopMenuLabel } from "./desktopMenuLabels.js";
import {
  resolveMenuAccelerator,
  resolveMenuDisplayAccelerator,
} from "./desktopMenuAccelerators.js";

/** 菜单构建的共享参数。 */
export interface ApplicationMenuBuildOptions {
  currentApplicationLocale: Locale;
  zcodeEndpointSelection?: "production" | "test" | "custom";
  executeDesktopCommand: (
    command: DesktopCommandId,
    senderWindow?: BrowserWindow | null,
  ) => Promise<unknown>;
  /** 下发一条渲染进程命令（保存、关闭编辑器、查找…） */
  executeUiCommand: (command: UiCommandId) => void;
  currentZoomLevel?: number;
  shortcutBindings?: Record<string, string[]>;
  /** 快捷键设置页录制态：true 时摘掉全部可配置 accelerator */
  disableShortcutAccelerators?: boolean;
  /** 开发态 Agent stdio 抓包开关的状态 */
  stdioTapState?: { visible: boolean; enabled: boolean };
}

/**
 * 文件 / 编辑子菜单。
 *
 * 这两个菜单的条目会随界面增删（保存类、查找类只在文件界面出现），
 * 默认隐藏，由菜单上下文投影原地改 visible。
 */
export function buildFileAndEditSubmenus(
  options: ApplicationMenuBuildOptions,
): Electron.MenuItemConstructorOptions[] {
  const getLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
    getDesktopMenuLabel(options.currentApplicationLocale, id);
  // macOS 的 Cmd+W 语义是「关闭当前编辑器」，其它平台沿用「关闭窗口」。
  const isMacDesktop = process.platform === "darwin";

  return [
    {
      label: getLabel(desktopMenuMessageIds.file),
      submenu: [
        {
          id: DESKTOP_MENU_ITEM_IDS.fileNewTask,
          label: getLabel(desktopMenuMessageIds.fileNewTask),
          accelerator: resolveMenuAccelerator(options, "newTask"),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.NewTask),
        },
        {
          id: DESKTOP_MENU_ITEM_IDS.fileNewFile,
          label: getLabel(desktopMenuMessageIds.fileNewFile),
          accelerator: resolveMenuAccelerator(options, "newFile"),
          // 按键由渲染进程的统一快捷键分发消费，菜单只显示键位，避免双触发。
          registerAccelerator: false,
          click: () => options.executeUiCommand(UiCommandIds.NewFile),
        },
        {
          id: DESKTOP_MENU_ITEM_IDS.fileOpenWorkspace,
          label: getLabel(desktopMenuMessageIds.fileOpenWorkspace),
          accelerator: resolveMenuAccelerator(options, "openWorkspace"),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenWorkspace),
        },
        // 保存类条目只在文件界面出现，默认隐藏，由菜单上下文显隐控制。
        {
          id: DESKTOP_MENU_ITEM_IDS.fileSeparatorSave,
          type: "separator" as const,
          visible: false,
        },
        {
          id: DESKTOP_MENU_ITEM_IDS.fileSave,
          label: getLabel(desktopMenuMessageIds.fileSave),
          accelerator: resolveMenuAccelerator(options, "saveFile"),
          registerAccelerator: false,
          visible: false,
          click: () => options.executeUiCommand(UiCommandIds.SaveFile),
        },
        {
          id: DESKTOP_MENU_ITEM_IDS.fileSaveAs,
          label: getLabel(desktopMenuMessageIds.fileSaveAs),
          accelerator: resolveMenuAccelerator(options, "saveFileAs"),
          registerAccelerator: false,
          visible: false,
          click: () => options.executeUiCommand(UiCommandIds.SaveFileAs),
        },
        {
          id: DESKTOP_MENU_ITEM_IDS.fileSaveAll,
          label: getLabel(desktopMenuMessageIds.fileSaveAll),
          accelerator: resolveMenuAccelerator(options, "saveAllFiles"),
          registerAccelerator: false,
          visible: false,
          click: () => options.executeUiCommand(UiCommandIds.SaveAllFiles),
        },
        {
          id: DESKTOP_MENU_ITEM_IDS.fileSeparatorClose,
          type: "separator" as const,
          visible: false,
        },
        ...(isMacDesktop
          ? [
              {
                id: DESKTOP_MENU_ITEM_IDS.fileCloseEditor,
                label: getLabel(desktopMenuMessageIds.fileCloseEditor),
                accelerator: resolveMenuAccelerator(options, "closeActiveContext"),
                // Electron 的 acceleratorWorksWhenHidden 默认是 true：条目隐藏后
                // 它的 accelerator 仍然会触发。「关闭编辑器」只在文件界面出现，
                // 必须显式关掉，否则任务界面按 Cmd+W 仍会关编辑器。
                acceleratorWorksWhenHidden: false,
                visible: false,
                // 走业务命令，让渲染进程按当前界面决定关哪个编辑器标签。
                click: () =>
                  void options.executeDesktopCommand(DesktopCommandIds.CloseActiveContext),
              },
            ]
          : [
              {
                id: DESKTOP_MENU_ITEM_IDS.fileCloseWindow,
                label: getLabel(desktopMenuMessageIds.windowCloseWindow),
                accelerator: resolveMenuAccelerator(options, "closeActiveContext"),
                click: () =>
                  void options.executeDesktopCommand(DesktopCommandIds.CloseActiveContext),
              },
            ]),
      ],
    },
    {
      label: getLabel(desktopMenuMessageIds.edit),
      // 顶层使用 Electron 的 editMenu/windowMenu role 会按系统/Electron locale 生成文案，
      // 和应用内 currentApplicationLocale 混用后出现“文件 Edit 视图 Window 帮助”的中英混排。
      submenu: [
        {
          id: DESKTOP_MENU_ITEM_IDS.editUndo,
          label: getLabel(desktopMenuMessageIds.editUndo),
          accelerator: resolveMenuDisplayAccelerator(options, UiCommandIds.Undo),
          // 原生 undo role 走 Chromium 撤销栈，在代码编辑器里撤销不了刚敲的代码。
          // 改成把命令交给渲染进程，由它按失焦前的编辑目标决定撤销谁。
          registerAccelerator: false,
          click: () => options.executeUiCommand(UiCommandIds.Undo),
        },
        {
          id: DESKTOP_MENU_ITEM_IDS.editRedo,
          label: getLabel(desktopMenuMessageIds.editRedo),
          accelerator: resolveMenuDisplayAccelerator(options, UiCommandIds.Redo),
          registerAccelerator: false,
          click: () => options.executeUiCommand(UiCommandIds.Redo),
        },
        { type: "separator" as const },
        { label: getLabel(desktopMenuMessageIds.editCut), role: "cut" as const },
        { label: getLabel(desktopMenuMessageIds.editCopy), role: "copy" as const },
        { label: getLabel(desktopMenuMessageIds.editPaste), role: "paste" as const },
        {
          id: DESKTOP_MENU_ITEM_IDS.editSeparatorFind,
          type: "separator" as const,
          visible: false,
        },
        {
          id: DESKTOP_MENU_ITEM_IDS.editFind,
          label: getLabel(desktopMenuMessageIds.editFind),
          // 查找的键位与「在任务中查找」是同一条命令：渲染进程按当前界面分派，
          // 菜单只显示键位、不向系统注册，实际按键由统一快捷键分发消费。
          accelerator: resolveMenuAccelerator(options, "findInTask"),
          registerAccelerator: false,
          visible: false,
          click: () => options.executeUiCommand(UiCommandIds.FindInEditor),
        },
        {
          id: DESKTOP_MENU_ITEM_IDS.editFindReplace,
          label: getLabel(desktopMenuMessageIds.editFindReplace),
          accelerator: resolveMenuAccelerator(options, "findReplaceInEditor"),
          registerAccelerator: false,
          visible: false,
          click: () => options.executeUiCommand(UiCommandIds.FindReplaceInEditor),
        },
        { type: "separator" as const },
        { label: getLabel(desktopMenuMessageIds.editSelectAll), role: "selectAll" as const },
      ],
    },
  ];
}
