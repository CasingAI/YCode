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

// macOS 上既不挂 parent 也不 modal：挂 parent 仍是子窗口，hide() 会先摘掉再
// orderOut；系统圆角/阴影在背板淡掉之后还会再走一拍。定位仍用参照窗口，
// 只是不把参照窗口交给 BrowserWindow。Windows / Linux 继续挂接并 modal。
export function resolveAboutWindowAttachParent<T>(
  parent: T | undefined,
  platform: NodeJS.Platform = process.platform,
): T | undefined {
  if (platform === "darwin") {
    return undefined;
  }
  return parent;
}

export function shouldUseAboutWindowModal(
  hasParent: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return hasParent && platform !== "darwin";
}

// 按父窗口内容区放置：水平居中、贴顶部。接近原先 sheet 的位置，但不走 sheet。
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
