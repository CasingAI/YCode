import { app, BrowserWindow, Menu } from "electron";
import { type DesktopCommandId, type Locale, type UiCommandId } from "@zcode/shared";
import { readZCodeStdioTapDevState } from "@zcode/services/node";
import { setAutoUpdaterMenuLocale } from "./autoUpdater.js";
import { buildApplicationMenuTemplate } from "./desktopApplicationMenuTemplate.js";
import { HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID } from "./desktopMenuItems.js";

export { DESKTOP_MENU_FILES_ONLY_ITEM_IDS, DESKTOP_MENU_ITEM_IDS } from "./desktopMenuItems.js";
export { getDesktopMenuLabel } from "./desktopApplicationMenuTemplate.js";

export function resolveSystemApplicationLocale(): Locale {
  // macOS 系统语言为中文时，Electron app.getLocale() 仍可能返回 en-US；
  // 优先读取系统首选语言列表，避免 System default 被误解析成英文。
  const systemLocale = app.getPreferredSystemLanguages?.()[0] ?? app.getLocale();
  return systemLocale.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function updateZCodeStdioTapDevMenuState() {
  const menu = Menu.getApplicationMenu();
  const item = menu?.getMenuItemById(HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID);
  if (!item) {
    return;
  }
  const state = readZCodeStdioTapDevState();
  item.checked = state.enabled;
  item.visible = state.visible;
}

export function rebuildApplicationMenu(options: {
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
}) {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildApplicationMenuTemplate({
        currentApplicationLocale: options.currentApplicationLocale,
        zcodeEndpointSelection: options.zcodeEndpointSelection,
        executeDesktopCommand: options.executeDesktopCommand,
        executeUiCommand: options.executeUiCommand,
        currentZoomLevel: options.currentZoomLevel,
        shortcutBindings: options.shortcutBindings,
        disableShortcutAccelerators: options.disableShortcutAccelerators,
        stdioTapState: options.stdioTapState ?? readZCodeStdioTapDevState(),
      }),
    ),
  );
  setAutoUpdaterMenuLocale(options.currentApplicationLocale);
  if (!app.isPackaged) {
    updateZCodeStdioTapDevMenuState();
  }
}
