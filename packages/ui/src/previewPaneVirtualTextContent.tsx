import { useCallback, useEffect, useMemo, useRef, type Ref, type UIEventHandler } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/components/lib/utils.js";

/**
 * 大文本只读预览：全文仍保留在内存中，但只把可视行挂进 DOM。
 *
 * Side Pane 的普通 `CodeViewer` 会为每行生成节点；9.7 MiB 的多行 JSON 会产生
 * 几十万行 DOM，打开即卡顿。这里只负责展示已读取的完整正文，不做编辑、高亮
 * 或第二套读取；滚动容器仍是 `PreviewPane` 用于保存 / 恢复位置的那一个。
 */
export function PreviewPaneVirtualTextContent({
  code,
  title,
  showLineNumbers,
  wrapLongLines,
  fontSizePx,
  onScroll,
  scrollContainerRef,
}: {
  code: string;
  title: string;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
  fontSizePx: number;
  onScroll?: UIEventHandler<HTMLDivElement>;
  scrollContainerRef?: Ref<HTMLDivElement>;
}) {
  const internalRef = useRef<HTMLDivElement | null>(null);
  const lines = useMemo(() => code.split("\n"), [code]);
  const lineHeightPx = Math.max(12, Math.round(fontSizePx * 1.5));
  const gutterWidth = useMemo(() => String(lines.length).length, [lines.length]);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => internalRef.current,
    estimateSize: () => lineHeightPx,
    overscan: 20,
  });
  const virtualItems = virtualizer.getVirtualItems();
  // 换行模式改变会改变真实行高；保留旧的测量值会让滚动高度和位置错乱，
  // 因此只在用户切换换行时重置测量，不在首次挂载时多触发一次重算。
  const previousWrapLongLinesRef = useRef(wrapLongLines);
  useEffect(() => {
    if (previousWrapLongLinesRef.current === wrapLongLines) {
      return;
    }
    previousWrapLongLinesRef.current = wrapLongLines;
    virtualizer.measure();
  }, [virtualizer, wrapLongLines]);

  const assignScrollContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      internalRef.current = node;
      if (!scrollContainerRef) {
        return;
      }
      if (typeof scrollContainerRef === "function") {
        scrollContainerRef(node);
        return;
      }
      (scrollContainerRef as { current: HTMLDivElement | null }).current = node;
    },
    [scrollContainerRef],
  );

  return (
    <div
      ref={assignScrollContainerRef}
      className="h-full w-full overflow-auto bg-background font-mono text-foreground"
      data-preview-virtual-text="true"
      data-language="text"
      onScroll={onScroll}
      style={{ fontSize: `${fontSizePx}px` }}
    >
      <div
        aria-label={title}
        role="region"
        className="relative w-full py-2"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualItems.map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={wrapLongLines ? virtualizer.measureElement : undefined}
            className={cn(
              "absolute left-0 top-0 flex min-w-full items-start gap-3 px-3",
              wrapLongLines ? "w-full whitespace-pre-wrap break-words" : "w-max whitespace-pre",
            )}
            style={{
              transform: `translateY(${item.start}px)`,
              lineHeight: `${lineHeightPx}px`,
            }}
          >
            {showLineNumbers ? (
              <span
                aria-hidden="true"
                className="shrink-0 select-none text-right text-foreground-subtlest"
                style={{ width: `${gutterWidth}ch` }}
              >
                {item.index + 1}
              </span>
            ) : null}
            <span className={wrapLongLines ? "min-w-0 break-words" : undefined}>
              {lines[item.index] ?? ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
