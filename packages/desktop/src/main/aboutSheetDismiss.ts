import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { BrowserWindow } from "electron";

interface AboutSheetNative {
  endAttachedSheet(handle: Buffer): boolean;
}

const SHEET_END_FALLBACK_MS = 600;

let nativeAddon: AboutSheetNative | undefined;
let nativeLoadAttempted = false;

export function resolveAboutSheetNativePath(
  dirname = import.meta.dirname,
  resourcesPath = process.resourcesPath,
): string {
  const relative = join("macos-about-sheet", "about-sheet.node");
  if (typeof resourcesPath === "string" && resourcesPath.length > 0) {
    const packaged = join(resourcesPath, relative);
    if (existsSync(packaged)) {
      return packaged;
    }
  }
  return join(dirname, "..", "..", "resources", relative);
}

function loadAboutSheetNative(): AboutSheetNative | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  if (nativeLoadAttempted) {
    return nativeAddon;
  }
  nativeLoadAttempted = true;
  const addonPath = resolveAboutSheetNativePath();
  if (!existsSync(addonPath)) {
    return undefined;
  }
  try {
    const require = createRequire(import.meta.url);
    nativeAddon = require(addonPath) as AboutSheetNative;
  } catch {
    nativeAddon = undefined;
  }
  return nativeAddon;
}

/** 对 macOS sheet 调用 endSheet，不先拆窗口。成功则在收场结束后回调。 */
export function dismissMacAboutSheet(win: BrowserWindow, onFinished: () => void): boolean {
  const native = loadAboutSheetNative();
  if (!native) {
    return false;
  }
  let handle: Buffer;
  try {
    handle = win.getNativeWindowHandle();
  } catch {
    return false;
  }

  let finished = false;
  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    onFinished();
  };

  const parent = win.getParentWindow();
  if (parent && !parent.isDestroyed()) {
    parent.once("sheet-end", finish);
  }

  const started = native.endAttachedSheet(handle);
  if (!started) {
    if (parent && !parent.isDestroyed()) {
      parent.removeListener("sheet-end", finish);
    }
    return false;
  }

  setTimeout(finish, SHEET_END_FALLBACK_MS);
  return true;
}
