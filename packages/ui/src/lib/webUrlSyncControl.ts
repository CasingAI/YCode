/**
 * Web URL 路由开关。
 *
 * 只有 Web 入口会在渲染 Root 之前打开它；桌面（Electron）没有地址栏，
 * 不打开就不会注册 popstate 监听、也不会 pushState。与 setStreamClientId
 * 同为「入口设置一次、整棵 UI 读取」的进程内能力开关。
 */
let enabled = false;

export function setWebUrlSyncEnabled(value: boolean): void {
  enabled = value;
}

export function isWebUrlSyncEnabled(): boolean {
  return enabled;
}
