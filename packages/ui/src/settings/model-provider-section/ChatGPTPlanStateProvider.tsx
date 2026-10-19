import { createContext, useContext, type ReactNode } from "react";
import { useChatGPTPlan } from "@/hooks/useChatGPTPlan.js";

export type ChatGPTPlanController = ReturnType<typeof useChatGPTPlan>;

const ChatGPTPlanStateContext = createContext<ChatGPTPlanController | null>(null);

/**
 * ChatGPT Plan 账户投影的唯一 React 订阅点。状态卡（statusSection）与账户行
 * （卡片底部）都要读同一份投影，不能各自调用 useChatGPTPlan 建第二条订阅。
 */
export function ChatGPTPlanStateProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const controller = useChatGPTPlan(enabled);
  return (
    <ChatGPTPlanStateContext.Provider value={controller}>
      {children}
    </ChatGPTPlanStateContext.Provider>
  );
}

export function useChatGPTPlanController(): ChatGPTPlanController {
  const controller = useContext(ChatGPTPlanStateContext);
  if (!controller) {
    throw new Error("ChatGPT Plan 状态必须在 ChatGPTPlanStateProvider 内使用");
  }
  return controller;
}
