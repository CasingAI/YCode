import type { ReactNode } from "react";

// Markdown 预览可能读取主题；这里只替换应用级 store 边界，不让夹具依赖完整 YCode 根状态。
const state = { theme: "light" as const };

export function useZCodeStore<T>(selector: (value: typeof state) => T): T {
  return selector(state);
}

export function useZCodeStoreWithDefault<T>(
  selector: (value: typeof state) => T | undefined,
  defaultValue: T,
): T {
  const value = selector(state);
  return value === undefined ? defaultValue : value;
}

export function useZCodeStoreApi() {
  return {
    getState: () => state,
    setState: () => {},
    subscribe: () => () => {},
  };
}

export function ZCodeStoreProvider({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
