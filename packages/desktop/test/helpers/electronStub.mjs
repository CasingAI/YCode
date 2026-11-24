/**
 * electron 桩本体：实现测试用到的最小面。
 * 测试用 `__setWindows` 驱动窗口表，`__setMenu` 驱动应用菜单，
 * `__sent` 断言投递通道与载荷。
 */

export const __sent = [];
let windows = [];
let focusedWindowId = null;
let applicationMenu = null;

export function __setWindows(next) {
  windows = next.map((entry) => {
    const id = typeof entry === "number" ? entry : entry.id;
    return {
      id,
      webContents: {
        id,
        send(channel, payload) {
          __sent.push({ channel, payload, webContentsId: id });
        },
      },
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => true,
      restore() {},
      show() {},
      focus() {},
    };
  });
  focusedWindowId = windows[0]?.id ?? null;
}

/** 指定当前焦点窗口（菜单上下文投影按它切换）。 */
export function __setFocusedWindow(id) {
  focusedWindowId = id;
}

export function __clearSent() {
  __sent.length = 0;
}

/** 装一份假的应用菜单：按 id 索引条目，供 getMenuItemById 查找。 */
export function __setMenu(items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  applicationMenu = {
    __items: items,
    getMenuItemById: (id) => byId.get(id) ?? null,
  };
}

export function __clearMenu() {
  applicationMenu = null;
}

export const BrowserWindow = {
  getFocusedWindow: () => windows.find((win) => win.id === focusedWindowId) ?? windows[0] ?? null,
  getAllWindows: () => [...windows],
  fromWebContents: (sender) =>
    windows.find((win) => win.webContents === sender || win.webContents.id === sender?.id) ?? null,
};

export const app = {
  name: "YCode",
  setAsDefaultProtocolClient: () => true,
  show() {},
  isPackaged: false,
  getPath: () => "/tmp",
  getVersion: () => "41.0.3",
  getLocale: () => "zh-CN",
  getPreferredSystemLanguages: () => ["zh-CN"],
  setAboutPanelOptions(options) {
    app.__aboutPanelOptions = options;
  },
  async showAboutPanel() {
    app.__aboutPanelShown = true;
  },
  __aboutPanelOptions: undefined,
  __aboutPanelShown: false,
};

/** 原生对话框调用记录：{ kind: "open" | "save", args }。 */
export const __dialogCalls = [];
let openDialogResult = { canceled: true, filePaths: [] };
let saveDialogResult = { canceled: true, filePath: undefined };

export function __setOpenDialogResult(result) {
  openDialogResult = result;
}

export function __setSaveDialogResult(result) {
  saveDialogResult = result;
}

export function __clearDialogCalls() {
  __dialogCalls.length = 0;
}

export const dialog = {
  showMessageBoxSync: () => 0,
  async showOpenDialog(...args) {
    __dialogCalls.push({ kind: "open", args });
    return openDialogResult;
  },
  async showSaveDialog(...args) {
    __dialogCalls.push({ kind: "save", args });
    return saveDialogResult;
  },
};

export const Menu = {
  buildFromTemplate: (template) => ({ __template: template }),
  setApplicationMenu: (menu) => {
    applicationMenu = menu;
  },
  getApplicationMenu: () => applicationMenu,
};

/** 记录 ipcMain.handle 注册的 handler，供主进程 IPC 单测直接调用。 */
export const __ipcHandlers = new Map();

export function __getIpcHandler(channel) {
  return __ipcHandlers.get(channel);
}

export function __clearIpcHandlers() {
  __ipcHandlers.clear();
}

export const ipcMain = {
  on: () => {},
  off: () => {},
  once: () => {},
  removeListener: () => {},
  handle: (channel, handler) => {
    __ipcHandlers.set(channel, handler);
  },
  removeHandler: (channel) => {
    __ipcHandlers.delete(channel);
  },
};

export const shell = {
  openExternal: async () => {},
  openPath: async () => {},
  showItemInFolder: () => {},
};

export const nativeImage = {
  createFromPath: () => ({ isEmpty: () => true, toDataURL: () => "" }),
  createFromDataURL: () => ({ isEmpty: () => true, toDataURL: () => "" }),
};

export const webContents = {
  getAllWebContents: () => windows.map((win) => win.webContents),
};

/**
 * session 命名导出桩：desktopNetworkPolicy 等模块经 browserDataManager 间接 import
 * `session`（值导入），ESM 只校验导出存在；网络策略测试自带按分区记录调用的 fake session。
 */
export const session = {
  fromPartition: () => ({}),
};

/** 测试可注册 fake guest（`<webview>` WebContents），供 BrowserGuestManager.attachGuest 解析。 */
let registeredWebContents = new Map();

export function __setWebContents(entries) {
  registeredWebContents = new Map(entries.map((entry) => [entry.id, entry]));
}

export function __clearWebContents() {
  registeredWebContents = new Map();
}

webContents.fromId = (id) => registeredWebContents.get(id) ?? null;
