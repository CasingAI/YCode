import { useEffect, useState } from "react";
import { resolveAssistantSectionMinHeight } from "@/v4/AssistantSectionReadingInteraction.js";

/**
 * 卡片最小高度：优先测量真实阅读容器，拿不到时回退视口。
 * 只写组件局部 CSS 数值，不写阅读 store，也不调整滚动位置。
 */
export function useAssistantSectionMinHeight(options: {
  enabled: boolean;
  getScrollRoot?: () => HTMLElement | null;
}): number | null {
  const [measuredMinHeight, setMeasuredMinHeight] = useState<number | null>(null);

  // 父级滚动节点的 ref 在子级布局阶段可能尚未挂载，提交完成后再绑定尺寸观察。
  useEffect(() => {
    if (!options.enabled) {
      setMeasuredMinHeight(null);
      return;
    }
    if (typeof window === "undefined") return;
    const root = options.getScrollRoot?.() ?? null;
    const update = () => {
      const rootHeight = root
        ? root.getBoundingClientRect().height || root.clientHeight
        : undefined;
      setMeasuredMinHeight(
        resolveAssistantSectionMinHeight({
          availableHeight: rootHeight,
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth,
          availableWidth: root?.clientWidth,
        }),
      );
    };
    update();
    // 窗口宽度决定窄屏比例，因此始终监听 resize；容器高度变化由 ResizeObserver 补齐。
    window.addEventListener("resize", update);
    if (!root || typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [options.enabled, options.getScrollRoot]);

  return measuredMinHeight;
}
