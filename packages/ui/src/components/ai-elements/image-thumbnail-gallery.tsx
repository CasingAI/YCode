"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Children, isValidElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export const imageThumbnailTriggerClassName =
  "my-4 block w-fit max-w-1/2 cursor-zoom-in overflow-hidden rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export const imageThumbnailClassName =
  "h-auto max-h-90 max-w-full rounded-xl border border-border bg-background object-cover";

// 横滑图集内子项的尺寸约束：固定高度、按原图比例取宽、吸附行首。
// 作用在 ScrollFadeViewport 的内容行上（它是 trigger 的直接父级），沿用
// 子选择器模式以绕过 Streamdown harden 对 rehype 自定义属性的限制。
const GALLERY_STRIP_TRIGGER_CLASSES =
  "gap-2 pb-1 [&>[data-image-thumbnail-trigger]]:my-0 [&>[data-image-thumbnail-trigger]]:h-40 [&>[data-image-thumbnail-trigger]]:w-auto [&>[data-image-thumbnail-trigger]]:max-w-none [&>[data-image-thumbnail-trigger]]:shrink-0 [&>[data-image-thumbnail-trigger]]:snap-start [&>[data-image-thumbnail-trigger]]:overflow-hidden [&>[data-image-thumbnail-trigger]]:rounded-xl [&>[data-image-thumbnail-trigger]>img]:h-full [&>[data-image-thumbnail-trigger]>img]:w-auto [&>[data-image-thumbnail-trigger]>img]:max-h-none [&>[data-image-thumbnail-trigger]>img]:max-w-none md:[&>[data-image-thumbnail-trigger]]:h-44";

function countMeaningfulChildren(children: ReactNode): number {
  return Children.toArray(children).filter(
    (child) => isValidElement(child) || (typeof child === "string" && child.trim().length > 0),
  ).length;
}

function ImageGalleryStrip({ children, className, ...props }: ComponentProps<"div">) {
  const { intl } = useZCodeIntl();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const meaningfulCount = useMemo(() => countMeaningfulChildren(children), [children]);

  const updateScrollState = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth;
    setCanScrollLeft(viewport.scrollLeft > 1);
    setCanScrollRight(viewport.scrollLeft < maxScrollLeft - 1);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    updateScrollState();
    viewport.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", updateScrollState);
    // 懒加载图片的 src 写入与尺寸变化只改 scrollWidth，不会触发 viewport 自身
    // 的 resize；监听子树 src 属性变化兜底，保证两端箭头的禁用态及时刷新。
    const observer = new MutationObserver(updateScrollState);
    observer.observe(viewport, {
      attributeFilter: ["src"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    return () => {
      viewport.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
      observer.disconnect();
    };
  }, [meaningfulCount, updateScrollState]);

  const scrollByPage = (direction: -1 | 1) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollBy({
      behavior: "smooth",
      left: direction * viewport.clientWidth * 0.9,
    });
  };

  const arrowBaseClassName =
    "absolute top-1/2 z-10 size-7 -translate-y-1/2 place-items-center rounded-full border border-border bg-background/90 text-foreground shadow-sm backdrop-blur transition-opacity hover:bg-surface focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-0 md:opacity-0 md:group-hover/gallery:opacity-100";

  return (
    <div className={cn("group/gallery relative my-4", className)} {...props}>
      <ScrollFadeViewport
        className="snap-x snap-mandatory rounded-xl"
        contentClassName={GALLERY_STRIP_TRIGGER_CLASSES}
        orientation="horizontal"
        ref={viewportRef}
      >
        {children}
      </ScrollFadeViewport>
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "chat.markdown.gallery.scrollLeft" })}
        className={cn(arrowBaseClassName, "left-2 opacity-60 md:left-2")}
        disabled={!canScrollLeft}
        onClick={() => {
          scrollByPage(-1);
        }}
      >
        <ChevronLeftIcon aria-hidden="true" className="size-4" />
      </button>
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "chat.markdown.gallery.scrollRight" })}
        className={cn(arrowBaseClassName, "right-2 opacity-60")}
        disabled={!canScrollRight}
        onClick={() => {
          scrollByPage(1);
        }}
      >
        <ChevronRightIcon aria-hidden="true" className="size-4" />
      </button>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-2 top-2 z-10 rounded-full border border-border bg-background/90 px-2 py-0.5 text-ui-sm text-foreground-subtle backdrop-blur"
      >
        {intl.formatMessage({ id: "chat.markdown.gallery.count" }, { count: meaningfulCount })}
      </span>
    </div>
  );
}

export function ImageThumbnailGallery({
  children,
  className,
  grouped = true,
  ...props
}: ComponentProps<"div"> & { grouped?: boolean }) {
  if (!grouped) {
    return (
      <div className={cn("contents", className)} {...props}>
        {children}
      </div>
    );
  }
  return (
    <ImageGalleryStrip className={className} {...props}>
      {children}
    </ImageGalleryStrip>
  );
}
