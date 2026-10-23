import { BrowserWindow, Menu } from "electron";
import { isDesktopMenuFilesView, type DesktopMenuContext } from "@zcode/shared";
import { DESKTOP_MENU_FILES_ONLY_ITEM_IDS, DESKTOP_MENU_ITEM_IDS } from "./desktopMenuItems.js";

/**
 * 桌面应用菜单的上下文投影缓存。
 *
 * macOS 的应用菜单全局只有一份，菜单内容必须跟随焦点窗口。主进程按窗口 id 保存
 * 渲染进程上报的上下文投影，再把焦点窗口的投影原地应用到菜单条目上。
 *
 * 这里的上下文只是投影：条目是否可执行的最终判断在渲染进程（界面可能比投影更新）。
 */

/** 按窗口 id 保存的菜单上下文投影。 */
const contextByWindowId = new Map<number, DesktopMenuContext>();

function setItemEnabled(id: string, enabled: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById(id);
  if (!item) {
    return;
  }
  item.enabled = enabled;
}

/**
 * 把一份上下文投影应用到当前应用菜单。
 *
 * 没有上下文（应用刚启动、窗口还没上报）时按「不在文件界面」处理：
 * 文件专属条目保持隐藏，编辑器相关条目置灰。
 */
export function applyDesktopMenuContext(context: DesktopMenuContext | null): void {
  const menu = Menu.getApplicationMenu();
  if (!menu) {
    return;
  }
  const inFilesView = isDesktopMenuFilesView(context);
  const editor = inFilesView ? (context?.editor ?? null) : null;

  for (const id of DESKTOP_MENU_FILES_ONLY_ITEM_IDS) {
    const item = menu.getMenuItemById(id);
    if (item) {
      item.visible = inFilesView;
    }
  }

  const canSave = Boolean(editor?.canSave);
  setItemEnabled(DESKTOP_MENU_ITEM_IDS.fileSave, canSave);
  setItemEnabled(DESKTOP_MENU_ITEM_IDS.fileSaveAs, canSave);
  setItemEnabled(DESKTOP_MENU_ITEM_IDS.fileSaveAll, (editor?.dirtyFileCount ?? 0) > 0);
  setItemEnabled(DESKTOP_MENU_ITEM_IDS.fileCloseEditor, Boolean(editor?.hasActiveEditor));
}

/** 应用焦点窗口的上下文投影。 */
export function applyFocusedDesktopMenuContext(): void {
  const focused = BrowserWindow.getFocusedWindow();
  applyDesktopMenuContextForWindow(focused && !focused.isDestroyed() ? focused.id : null);
}

/** 弹出菜单复用来源窗口的投影，不把其它焦点窗口的能力带过来。 */
export function applyDesktopMenuContextForWindow(windowId: number | null): void {
  applyDesktopMenuContext(windowId === null ? null : (contextByWindowId.get(windowId) ?? null));
}

/** 记录某个窗口上报的菜单上下文，并刷新当前菜单。 */
export function setDesktopMenuContextForWindow(
  windowId: number,
  context: DesktopMenuContext,
): void {
  contextByWindowId.set(windowId, context);
  applyFocusedDesktopMenuContext();
}

/** 窗口关闭时清理它的上下文。 */
export function clearDesktopMenuContextForWindow(windowId: number): void {
  if (!contextByWindowId.delete(windowId)) {
    return;
  }
  applyFocusedDesktopMenuContext();
}
