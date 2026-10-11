import { create } from "zustand";

/**
 * 会话引用外部唤起意图（`ycode://session/open?sessionId=…&search=…` 经系统
 * 进主进程、再经 IPC 到 renderer）。
 *
 * 写方是 Root 层的 `useRootPlatformEffects`（订阅 platform.onSessionCitationOpen）；
 * 读方是 App 层（有 handleSelectTask + handleSearchResultHighlightRequest 的
 * 完整跳转能力）。Root 与 App 隔着 RootShell/RootWorkspaceContent，逐层透传
 * 回调不划算，用这个小 store 解耦。只存待办意图，消费后即清（单次语义）。
 */
export interface SessionCitationDeepLinkIntent {
  sessionId: string;
  search: string;
  /** 递增版本号：同一 session 重复唤起仍能触发消费。 */
  revision: number;
}

interface SessionCitationDeepLinkState {
  readonly intent: SessionCitationDeepLinkIntent | null;
  postIntent: (input: { sessionId: string; search: string }) => void;
  consumeIntent: (revision: number) => void;
}

export const useSessionCitationDeepLinkStore = create<SessionCitationDeepLinkState>()((set) => ({
  intent: null,
  postIntent: (input) =>
    set((state) => ({
      intent: {
        sessionId: input.sessionId,
        search: input.search,
        revision: (state.intent?.revision ?? 0) + 1,
      },
    })),
  consumeIntent: (revision) =>
    set((state) => (state.intent?.revision === revision ? { intent: null } : state)),
}));
