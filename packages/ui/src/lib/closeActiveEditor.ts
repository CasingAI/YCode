/**
 * 「关闭当前编辑器」请求事件与统一分发。
 *
 * 三个桌面平台（macOS / Windows / Linux）语义一致：关闭请求只关当前聚焦编辑器组的
 * 活动标签，任何界面都不回落为关侧栏标签或关窗口。
 * 规格见 docs/specs/desktop-application-menu.md「关闭编辑器快捷键的语义」。
 */
export const CLOSE_ACTIVE_EDITOR_REQUEST_EVENT = "zcode:close-active-editor-request";

/**
 * 派发「关闭当前编辑器」请求。
 *
 * 这是关闭请求的唯一分发实现：不分平台，也不提供任何回落分支——
 * 任务 / 设置界面没有可关的编辑器时，这条请求就是空操作。
 */
export function dispatchCloseActiveEditorRequest(target: EventTarget = window): void {
  target.dispatchEvent(new Event(CLOSE_ACTIVE_EDITOR_REQUEST_EVENT, { cancelable: true }));
}
