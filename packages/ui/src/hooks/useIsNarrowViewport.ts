import { useSyncExternalStore } from "react";
import { readNarrowViewportSnapshot, subscribeNarrowViewport } from "@/lib/narrowViewport.js";

// 当前视口是否窄屏。这是外壳「呈现形态」的唯一判定来源：宽度只决定侧栏是内联列
// 还是覆盖抽屉，侧栏显隐本身仍由用户意图（isSidebarVisible）决定。
export function useIsNarrowViewport(): boolean {
  return useSyncExternalStore(
    subscribeNarrowViewport,
    readNarrowViewportSnapshot,
    // 服务端/无 window 环境按宽视口渲染，保持既有桌面布局。
    () => false,
  );
}
