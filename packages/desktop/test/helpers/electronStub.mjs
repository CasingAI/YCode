/**
 * electron 桩本体：只实现深链路由测试用到的最小面。
 * 测试用 `__setWindows` 驱动窗口表，`__sent` 断言投递通道与载荷。
 */

export const __sent = [];
let windows = [];

export function __setWindows(next) {
  windows = next.map((id) => ({
    webContents: {
      id,
      send(channel, payload) {
        __sent.push({ channel, payload, webContentsId: id });
      },
    },
    isMinimized: () => false,
    isVisible: () => true,
    restore() {},
    show() {},
    focus() {},
  }));
}

export function __clearSent() {
  __sent.length = 0;
}

export const BrowserWindow = {
  getFocusedWindow: () => windows[0] ?? null,
  getAllWindows: () => [...windows],
};

export const app = {
  setAsDefaultProtocolClient: () => true,
  show() {},
  isPackaged: false,
  getPath: () => "/tmp",
};

export const dialog = {
  showMessageBoxSync: () => 0,
};
