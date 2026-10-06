import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  TID_V4_TURN_NAVIGATOR,
  TID_V4_TURN_NAVIGATOR_ITEM,
  TID_V4_TURN_NAVIGATOR_TOOLTIP,
  testId,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  resolveConversationTurnNavigatorActiveUnitIndex,
  resolveConversationTurnNavigatorBarVisualState,
  resolveConversationTurnNavigatorVisualFocusItemIndex,
  type ConversationTurnNavigatorItem,
  type ConversationTurnNavigatorVirtualItem,
} from "@/v4/conversationTurnNavigatorHelpers.js";

interface ConversationTurnNavigatorProps {
  /** CLI 目录侧信道条目（query/directory）：rowId 升序，数据源与时间线窗口解耦。 */
  items: readonly ConversationTurnNavigatorItem[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
  virtualItems: readonly ConversationTurnNavigatorVirtualItem[];
  /** 视口最上方那一行的 rowId（不限 kind）：active 的时序定位主判据。 */
  topmostRowId?: number;
  activeQueryRowId?: number;
  isHydratingDirectory?: boolean;
  /** 跳转目标只带稳定 row 身份；turn 由时间线按目录条目定位，不再依赖 render unit 下标。 */
  onJumpToQuery: (target: { rowId: number; turnId: string }, behavior: ScrollBehavior) => void;
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return prefersReducedMotion;
}

function ConversationTurnNavigatorImpl({
  items,
  scrollOffsetPx,
  viewportHeightPx,
  virtualItems,
  activeQueryRowId,
  isHydratingDirectory = false,
  onJumpToQuery,
}: ConversationTurnNavigatorProps) {
  const { intl } = useZCodeIntl();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [interactionItemIndex, setInteractionItemIndex] = useState<number | undefined>(undefined);

  const activeTurnId = useMemo(
    () =>
      resolveConversationTurnNavigatorActiveUnitIndex({
        items,
        scrollOffsetPx,
        viewportHeightPx,
        virtualItems,
      }),
    [items, scrollOffsetPx, viewportHeightPx, virtualItems],
  );
  const itemIndexes = useMemo(() => {
    const byRowId = new Map<number, number>();
    const firstByTurnId = new Map<string, number>();
    items.forEach((item, index) => {
      byRowId.set(item.rowId, index);
      if (!firstByTurnId.has(item.turnId)) {
        firstByTurnId.set(item.turnId, index);
      }
    });
    return { byRowId, firstByTurnId };
  }, [items]);
  const activeItemIndex =
    (activeQueryRowId === undefined ? undefined : itemIndexes.byRowId.get(activeQueryRowId)) ??
    (activeTurnId === undefined ? undefined : itemIndexes.firstByTurnId.get(activeTurnId)) ??
    -1;
  const visualFocusItemIndex = resolveConversationTurnNavigatorVisualFocusItemIndex({
    activeItemIndex,
    interactionItemIndex,
  });
  const railScrollRef = useRef<HTMLDivElement>(null);
  const getRailScrollElement = useCallback(() => railScrollRef.current, []);
  const getRailItemKey = useCallback((index: number) => items[index]?.key ?? index, [items]);
  const railVirtualizer = useVirtualizer({
    count: items.length,
    estimateSize: () => 10,
    getItemKey: getRailItemKey,
    getScrollElement: getRailScrollElement,
    overscan: 6,
  });
  const virtualRows = railVirtualizer.getVirtualItems();

  useEffect(() => {
    if (activeItemIndex < 0 || items.length < 2) return;
    railVirtualizer.scrollToIndex(activeItemIndex, { align: "auto" });
    const element = railScrollRef.current;
    if (!element) return;
    window.queueMicrotask(() => {
      if (railScrollRef.current !== element) return;
      // 目录从 tail 一次扩展到上千项时，scrollToIndex 与 virtualizer 的
      // measurement 更新处于同一个 commit，Chromium 可能合并 scroll 通知。补发通知
      // 只同步 rail observer，确保活动项对应的可视窗口立即挂载。
      element.dispatchEvent(new Event("scroll"));
    });
  }, [activeItemIndex, items.length, railVirtualizer]);

  if (items.length < 2) {
    return null;
  }

  return (
    <nav
      aria-label={intl.formatMessage({ id: "chat.turnNavigator.label" })}
      aria-busy={isHydratingDirectory}
      data-testid={TID_V4_TURN_NAVIGATOR}
      data-item-count={items.length}
      data-rendered-item-count={virtualRows.length}
      className="pointer-events-none invisible absolute inset-y-0 left-0 z-10 w-12 -translate-x-2 opacity-0 transition-[opacity,transform,visibility] duration-150 ease-out motion-reduce:transition-none @min-[864px]/conversation:visible @min-[864px]/conversation:translate-x-0 @min-[864px]/conversation:opacity-100"
    >
      <div
        ref={railScrollRef}
        // 只声明 overflow-y-auto 时，浏览器会把 overflow-x 计算为 auto；
        // hover 山峰横向放大后便可能触发横向滚动条，因此 rail 必须只开放纵向滚动。
        className="!scrollbar-hide pointer-events-auto absolute left-3 top-1/2 max-h-[calc(100%-6rem)] w-9 -translate-y-1/2 overflow-x-hidden overflow-y-auto py-1"
        onPointerLeave={() => setInteractionItemIndex(undefined)}
        onScroll={() => setInteractionItemIndex(undefined)}
      >
        <div className="relative w-9" style={{ height: `${railVirtualizer.getTotalSize()}px` }}>
          {virtualRows.map((virtualRow) => {
            const itemIndex = virtualRow.index;
            const item = items[itemIndex];
            if (!item) return null;
            const active = itemIndex === activeItemIndex;
            const visualState = resolveConversationTurnNavigatorBarVisualState({
              itemIndex,
              visualFocusItemIndex,
            });
            const showScrollActiveColor = visualFocusItemIndex === undefined && active;
            return (
              <div
                key={item.key}
                className="absolute left-0 top-0 h-2.5 w-9"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <HoverCard closeDelay={80} openDelay={120}>
                  <HoverCardTrigger asChild>
                    <button
                      type="button"
                      aria-current={active ? "location" : undefined}
                      aria-label={intl.formatMessage(
                        { id: "chat.turnNavigator.jumpToQuery" },
                        { index: String(itemIndex + 1) },
                      )}
                      aria-posinset={itemIndex + 1}
                      aria-setsize={items.length}
                      data-testid={testId(TID_V4_TURN_NAVIGATOR_ITEM, item.key)}
                      data-item-index={itemIndex}
                      data-turn-id={item.turnId}
                      data-query-row-id={item.rowId}
                      data-active={active ? "true" : "false"}
                      data-running={item.isRunning ? "true" : "false"}
                      data-visual-color-tone={visualState.colorTone}
                      data-visual-scale={String(visualState.scaleX)}
                      data-visual-tone={visualState.tone}
                      onBlur={() => setInteractionItemIndex(undefined)}
                      onClick={() =>
                        onJumpToQuery(
                          { rowId: item.rowId, turnId: item.turnId },
                          prefersReducedMotion ? "auto" : "smooth",
                        )
                      }
                      onFocus={() => setInteractionItemIndex(itemIndex)}
                      onPointerEnter={() => setInteractionItemIndex(itemIndex)}
                      onPointerLeave={() => setInteractionItemIndex(undefined)}
                      className="flex h-2.5 w-9 items-center justify-start rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <span
                        className={cn(
                          "block h-0.5 w-3 origin-left rounded-full transition-[height,opacity,transform,background-color] duration-150 ease-out motion-reduce:transition-none",
                          visualState.colorTone === "focus" && "bg-foreground",
                          visualState.colorTone === "muted" &&
                            (showScrollActiveColor ? "bg-foreground" : "bg-foreground-subtlest"),
                        )}
                        style={{
                          opacity: showScrollActiveColor
                            ? 0.9
                            : item.isRunning
                              ? Math.max(visualState.opacity, 0.72)
                              : visualState.opacity,
                          transform: `scaleX(${visualState.scaleX})`,
                        }}
                      />
                    </button>
                  </HoverCardTrigger>
                  <HoverCardContent
                    align="start"
                    side="right"
                    sideOffset={8}
                    data-testid={testId(TID_V4_TURN_NAVIGATOR_TOOLTIP, item.key)}
                    className="w-80 max-w-[calc(100vw-2rem)] border border-popover-border bg-popover p-3 text-popover-foreground shadow-lg"
                  >
                    <div className="space-y-2">
                      <p className="line-clamp-2 whitespace-pre-line text-ui-base font-medium leading-5">
                        {item.userPreview}
                      </p>
                      <p
                        className={cn(
                          "line-clamp-3 whitespace-pre-line text-ui-base leading-5",
                          item.assistantPreviewKind === "text"
                            ? "text-popover-foreground/80"
                            : "text-foreground-subtle",
                        )}
                      >
                        {item.assistantPreview}
                      </p>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

export const ConversationTurnNavigator = memo(ConversationTurnNavigatorImpl);
