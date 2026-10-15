import type { ComponentProps } from "react";
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";

type ScrollMaskState = "none" | "top" | "bottom" | "left" | "right" | "both";

// Tailwind arbitrary value 里用下划线表示 calc 空格，避免生成无效的 calc(100%-24px)。
const VERTICAL_MASK_CLASS_BY_STATE: Record<"top" | "bottom" | "both", string> = {
  top: "[mask-image:linear-gradient(to_bottom,transparent_0,black_24px,black_100%)] [-webkit-mask-image:linear-gradient(to_bottom,transparent_0,black_24px,black_100%)]",
  bottom:
    "[mask-image:linear-gradient(to_bottom,black_0,black_calc(100%_-_24px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_bottom,black_0,black_calc(100%_-_24px),transparent_100%)]",
  both: "[mask-image:linear-gradient(to_bottom,transparent_0,black_24px,black_calc(100%_-_24px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_bottom,transparent_0,black_24px,black_calc(100%_-_24px),transparent_100%)]",
};

const HORIZONTAL_MASK_CLASS_BY_STATE: Record<"left" | "right" | "both", string> = {
  left: "[mask-image:linear-gradient(to_right,transparent_0,black_24px,black_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0,black_24px,black_100%)]",
  right:
    "[mask-image:linear-gradient(to_right,black_0,black_calc(100%_-_24px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,black_0,black_calc(100%_-_24px),transparent_100%)]",
  both: "[mask-image:linear-gradient(to_right,transparent_0,black_24px,black_calc(100%_-_24px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0,black_24px,black_calc(100%_-_24px),transparent_100%)]",
};

export type ScrollFadeOrientation = "vertical" | "horizontal";

export function ScrollFadeViewport({
  orientation = "vertical",
  contentClassName,
  className,
  children,
  ref,
  ...props
}: ComponentProps<"div"> & {
  orientation?: ScrollFadeOrientation;
  /** 内容容器的额外类；横向时内容容器为 flex 行，可在此追加 gap 等布局类。 */
  contentClassName?: string;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [maskState, setMaskState] = useState<ScrollMaskState>("none");
  const horizontal = orientation === "horizontal";

  // 渐隐组件与调用方共享同一个滚动节点，Bash 原有吸底/暂停逻辑仍由调用方拥有。
  useImperativeHandle(ref, () => viewportRef.current!, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) {
      setMaskState("none");
      return;
    }

    const updateMaskState = () => {
      if (horizontal) {
        const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth;
        if (maxScrollLeft <= 1) {
          setMaskState("none");
          return;
        }
        const hasHiddenLeft = viewport.scrollLeft > 1;
        const hasHiddenRight = viewport.scrollLeft < maxScrollLeft - 1;
        setMaskState(
          hasHiddenLeft && hasHiddenRight
            ? "both"
            : hasHiddenLeft
              ? "left"
              : hasHiddenRight
                ? "right"
                : "none",
        );
        return;
      }

      const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
      if (maxScrollTop <= 1) {
        setMaskState("none");
        return;
      }

      const hasHiddenTop = viewport.scrollTop > 1;
      const hasHiddenBottom = viewport.scrollTop < maxScrollTop - 1;
      setMaskState(
        hasHiddenTop && hasHiddenBottom
          ? "both"
          : hasHiddenTop
            ? "top"
            : hasHiddenBottom
              ? "bottom"
              : "none",
      );
    };

    let rafId: number | null = null;
    const scheduleUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateMaskState();
      });
    };

    updateMaskState();
    viewport.addEventListener("scroll", updateMaskState, { passive: true });

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", scheduleUpdate);
      return () => {
        viewport.removeEventListener("scroll", updateMaskState);
        window.removeEventListener("resize", scheduleUpdate);
      };
    }

    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(viewport);
    resizeObserver.observe(content);
    window.addEventListener("resize", scheduleUpdate);

    return () => {
      viewport.removeEventListener("scroll", updateMaskState);
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [children, horizontal]);

  const maskClassName = horizontal
    ? HORIZONTAL_MASK_CLASS_BY_STATE[
        (maskState === "left" || maskState === "right" || maskState === "both"
          ? maskState
          : "both") as keyof typeof HORIZONTAL_MASK_CLASS_BY_STATE
      ]
    : VERTICAL_MASK_CLASS_BY_STATE[
        (maskState === "top" || maskState === "bottom" || maskState === "both"
          ? maskState
          : "both") as keyof typeof VERTICAL_MASK_CLASS_BY_STATE
      ];

  return (
    <div
      ref={viewportRef}
      data-scroll-mask={maskState}
      className={cn(
        "min-h-0 flex-1",
        horizontal ? "overflow-x-auto" : "overflow-y-auto",
        maskState === "none" ? "" : maskClassName,
        className,
      )}
      {...props}
    >
      <div ref={contentRef} className={cn(horizontal && "flex w-max", contentClassName)}>
        {children}
      </div>
    </div>
  );
}
