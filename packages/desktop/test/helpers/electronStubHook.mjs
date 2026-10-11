/**
 * electron 主进程 API 桩 loader（仅 node:test 用）。
 *
 * `desktopOAuthDeepLink.ts` 顶层 import electron（app/BrowserWindow/dialog），
 * 本环境无 Electron 二进制，直接加载会报 export 缺失。这里把 `electron`
 * 指向同目录的 `electronStub.mjs`，只实现 handleDeepLink session 分支用到的面：
 * BrowserWindow.getFocusedWindow/getAllWindows（静态表驱动）、webContents.send
 * （记录投递）、dialog/app（空实现）。被测的是真实路由逻辑，不是 mock 逻辑。
 */
export async function resolve(specifier, context, next) {
  if (specifier === "electron") {
    return {
      url: new URL("./electronStub.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
