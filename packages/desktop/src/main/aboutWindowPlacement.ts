import type { BrowserWindow } from "electron";

// 自定义 About 内容本体是 256x280；原生窗口如果同尺寸会让内容贴满透明窗口边界。
// 这里给 BrowserWindow 额外留出背景呼吸空间，避免正式 About 看起来比 demo 更局促。
export const ABOUT_WINDOW_WIDTH = 256;
export const ABOUT_WINDOW_HEIGHT = 320;

export interface AboutWindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AboutWindowSize {
  width: number;
  height: number;
}

// 有父窗口就挂接并做成 modal。macOS 上这就是系统 sheet，位置和打开动画由系统负责。
export function resolveAboutWindowAttachParent<T>(
  parent: T | undefined,
  _platform: NodeJS.Platform = process.platform,
): T | undefined {
  return parent;
}

export function shouldUseAboutWindowModal(
  hasParent: boolean,
  _platform: NodeJS.Platform = process.platform,
): boolean {
  return hasParent;
}

// 没有 sheet 时（无父窗口）按内容区水平居中、贴顶。
export function resolveAboutWindowPosition(
  parentContentBounds: AboutWindowRect,
  size: AboutWindowSize = { width: ABOUT_WINDOW_WIDTH, height: ABOUT_WINDOW_HEIGHT },
): { x: number; y: number } {
  return {
    x: Math.round(parentContentBounds.x + (parentContentBounds.width - size.width) / 2),
    y: parentContentBounds.y,
  };
}

export function positionAboutWindow(win: BrowserWindow, parent: BrowserWindow | undefined): void {
  if (!parent || parent.isDestroyed() || win.isDestroyed()) {
    win.center();
    return;
  }
  const next = resolveAboutWindowPosition(parent.getContentBounds());
  win.setPosition(next.x, next.y);
}
