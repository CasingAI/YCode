import { create } from "zustand";

/**
 * 命令中心 AI 搜索的后台指示状态（docs/specs/command-center-ai-history-search.md
 * 「侧栏入口的后台指示」）。
 *
 * Dialog 里的 runner 状态只活在 Dialog 内部，侧栏入口按钮够不着；App 与
 * WorkspaceShellLayout 中间隔了好几层，逐层透传 props 不划算。用这个小 store
 * 按 workspaceKey 广播：Dialog 写、侧栏读。只存展示事实（运行中/已收口未读），
 * 不存租约与投影，会话回收仍走 runner。
 */
export type AiHistorySearchBadge = "none" | "running" | "unread";

interface AiHistorySearchStatusState {
  readonly badgeByWorkspaceKey: Readonly<Record<string, AiHistorySearchBadge>>;
  setBadge: (workspaceKey: string, badge: AiHistorySearchBadge) => void;
}

export const useAiHistorySearchStatusStore = create<AiHistorySearchStatusState>()((set) => ({
  badgeByWorkspaceKey: {},
  setBadge: (workspaceKey, badge) =>
    set((state) => {
      if (badge === "none") {
        if (!(workspaceKey in state.badgeByWorkspaceKey)) return state;
        const next = { ...state.badgeByWorkspaceKey };
        delete next[workspaceKey];
        return { badgeByWorkspaceKey: next };
      }
      if (state.badgeByWorkspaceKey[workspaceKey] === badge) return state;
      return { badgeByWorkspaceKey: { ...state.badgeByWorkspaceKey, [workspaceKey]: badge } };
    }),
}));

/** 侧栏入口按钮读：该工作区有没有后台运行或没看的结果。 */
export function selectAiHistorySearchBadge(
  state: AiHistorySearchStatusState,
  workspaceKey: string,
): AiHistorySearchBadge {
  return state.badgeByWorkspaceKey[workspaceKey] ?? "none";
}
