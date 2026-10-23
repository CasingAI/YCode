import { Menu, type BrowserWindow } from "electron";
import { applyDesktopMenuContextForWindow } from "./desktopMenuContext.js";

/** 无边框窗口不绘制原生菜单栏；显式弹出既有菜单，保留唯一模板与上下文 owner。 */
export function showApplicationMenu(sourceWindow: BrowserWindow | null | undefined): void {
  if (!sourceWindow || sourceWindow.isDestroyed()) return;
  const menu = Menu.getApplicationMenu();
  if (!menu) return;

  // IPC 到达时焦点可能已变，必须以发起按钮点击的窗口决定条目显隐与可用状态。
  applyDesktopMenuContextForWindow(sourceWindow.id);
  menu.popup({ window: sourceWindow });
}
