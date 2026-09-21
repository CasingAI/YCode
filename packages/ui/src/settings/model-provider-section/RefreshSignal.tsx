import { createContext, useContext, type ReactNode } from "react";

/**
 * 模型设置页「页面级刷新」的共享信号。
 *
 * 顶部刷新按钮本来就是整页数据的刷新入口（模型列表、Team Plan 产品、Coding Plan
 * 权益都挂在它上面），卡片自己的数据源（OpenCode 用量）通过订阅 tick 变化重取，
 * 不必再让用户去点卡片里的按钮。
 *
 * tick 从 0 开始且只在点击刷新时递增：卡片挂载时读到的初始值不代表刷新请求，
 * 不能据此触发一次多余的网络往返。
 */
const ModelProviderRefreshSignalContext = createContext(0);

export function ModelProviderRefreshSignalProvider({
  tick,
  children,
}: {
  tick: number;
  children: ReactNode;
}) {
  return (
    <ModelProviderRefreshSignalContext.Provider value={tick}>
      {children}
    </ModelProviderRefreshSignalContext.Provider>
  );
}

/** 当前页面级刷新的 tick；值变化即表示用户点了顶部刷新。 */
export function useModelProviderRefreshTick(): number {
  return useContext(ModelProviderRefreshSignalContext);
}
