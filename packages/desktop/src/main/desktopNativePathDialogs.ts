import { PlatformChannels, type NativePathDialogOptions } from "@zcode/shared";
import { BrowserWindow, dialog, ipcMain } from "electron";
import type { IpcMainInvokeEvent, OpenDialogOptions, SaveDialogOptions } from "electron";

const MAX_DEFAULT_PATH_LENGTH = 4_096;
const MAX_DIALOG_TITLE_LENGTH = 200;
const INVALID_OPTIONS_ERROR = "invalid_native_dialog_options";

/**
 * 只接受可选的 defaultPath / title；类型或长度越界直接拒绝，避免把任意 IPC payload
 * 原样交给 Electron。这里不读取、不记录路径内容。
 */
function parseNativePathDialogOptions(raw: unknown): NativePathDialogOptions {
  if (raw === undefined) {
    return {};
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(INVALID_OPTIONS_ERROR);
  }

  const candidate = raw as Record<string, unknown>;
  const options: NativePathDialogOptions = {};
  if (candidate.defaultPath !== undefined) {
    if (
      typeof candidate.defaultPath !== "string" ||
      candidate.defaultPath.trim().length === 0 ||
      candidate.defaultPath.length > MAX_DEFAULT_PATH_LENGTH
    ) {
      throw new Error(INVALID_OPTIONS_ERROR);
    }
    options.defaultPath = candidate.defaultPath;
  }
  if (candidate.title !== undefined) {
    if (
      typeof candidate.title !== "string" ||
      candidate.title.trim().length === 0 ||
      candidate.title.length > MAX_DIALOG_TITLE_LENGTH
    ) {
      throw new Error(INVALID_OPTIONS_ERROR);
    }
    options.title = candidate.title;
  }
  return options;
}

function buildOpenDialogOptions(
  properties: NonNullable<OpenDialogOptions["properties"]>,
  options: NativePathDialogOptions,
): OpenDialogOptions {
  return {
    properties,
    ...(options.defaultPath ? { defaultPath: options.defaultPath } : {}),
    ...(options.title ? { title: options.title } : {}),
  };
}

function buildSaveDialogOptions(options: NativePathDialogOptions): SaveDialogOptions {
  return {
    ...(options.defaultPath ? { defaultPath: options.defaultPath } : {}),
    ...(options.title ? { title: options.title } : {}),
  };
}

function resolveParentWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

async function showOpenDialog(event: IpcMainInvokeEvent, options: OpenDialogOptions) {
  const parent = resolveParentWindow(event);
  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
}

async function showSaveDialog(event: IpcMainInvokeEvent, options: SaveDialogOptions) {
  const parent = resolveParentWindow(event);
  return parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options);
}

/**
 * 原生路径选择 IPC：目录 / 单文件 / 多文件 / 另存为。
 * 所有对话框以发起请求的窗口为父窗口；只返回路径，不写盘、不保存工作区状态。
 */
export function registerDesktopNativePathDialogIpcHandlers(): void {
  ipcMain.handle(PlatformChannels.SelectDirectory, async (event, rawOptions?: unknown) => {
    const options = parseNativePathDialogOptions(rawOptions);
    const result = await showOpenDialog(
      event,
      buildOpenDialogOptions(["openDirectory", "createDirectory"], options),
    );
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(PlatformChannels.SelectFile, async (event, rawOptions?: unknown) => {
    const options = parseNativePathDialogOptions(rawOptions);
    const result = await showOpenDialog(event, buildOpenDialogOptions(["openFile"], options));
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(PlatformChannels.SelectFiles, async (event, rawOptions?: unknown) => {
    const options = parseNativePathDialogOptions(rawOptions);
    const result = await showOpenDialog(
      event,
      buildOpenDialogOptions(["openFile", "multiSelections"], options),
    );
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle(PlatformChannels.ShowSaveDialog, async (event, rawOptions?: unknown) => {
    const options = parseNativePathDialogOptions(rawOptions);
    const result = await showSaveDialog(event, buildSaveDialogOptions(options));
    return result.canceled ? null : (result.filePath ?? null);
  });
}
