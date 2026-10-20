import type { WorkspaceSidePaneState, WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";
import { getActiveSidePaneTab } from "@/lib/workspaceSidePane.js";

export const CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT = "zcode:close-active-context-request";

/**
 * 「关闭当前编辑器」请求事件。
 *
 * 与 CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT 分开是因为两者语义不同、平台不同：
 * 前者是「关闭当前上下文」（侧栏标签 → 否则关窗口），后者只在 macOS 桌面端出现，
 * 语义严格限定为「关闭当前聚焦编辑器组的活动标签」，任何界面都不回落为关窗口。
 */
export const CLOSE_ACTIVE_EDITOR_REQUEST_EVENT = "zcode:close-active-editor-request";

export function getCloseActiveContextSidePaneTab(options: {
  isWorkspaceVisible: boolean;
  isSidePaneCollapsed: boolean;
  sidePaneState: WorkspaceSidePaneState | null;
}): WorkspaceSidePaneTab | null {
  if (!options.isWorkspaceVisible || options.isSidePaneCollapsed) {
    return null;
  }

  return getActiveSidePaneTab(options.sidePaneState);
}
