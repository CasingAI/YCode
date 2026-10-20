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

export const dialog = {
  showMessageBoxSync: () => 0,
};

export const Menu = {
  buildFromTemplate: (template) => ({ __template: template }),
  setApplicationMenu: (menu) => {
    applicationMenu = menu;
  },
  getApplicationMenu: () => applicationMenu,
};

export const ipcMain = {
  on: () => {},
  off: () => {},
  once: () => {},
  removeListener: () => {},
  handle: () => {},
  removeHandler: () => {},
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
