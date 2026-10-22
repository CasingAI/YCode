import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import {
  TID_CHAT_ASSISTANT_SECTION_NAV,
  TID_CHAT_ASSISTANT_SECTION_TAB,
  testId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface SectionNavigationItem {
  id: string;
  title: string;
}

interface AssistantSectionReadingHeaderProps {
  rowId: number;
  sections: readonly SectionNavigationItem[];
  activeSectionId: string | null;
  activeIndex: number;
  paged: boolean;
  pageLabel: string;
  onSelectSection: (sectionId: string) => void;
  onToggleMode: () => void;
}

export function AssistantSectionReadingHeader({
  rowId,
  sections,
  activeSectionId,
  activeIndex,
  paged,
  pageLabel,
  onSelectSection,
  onToggleMode,
}: AssistantSectionReadingHeaderProps) {
  const { intl } = useZCodeIntl();
  const viewportRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const showSectionTab = useCallback((sectionId: string) => {
    const viewport = viewportRef.current;
    const tab = tabRefs.current.get(sectionId);
    if (!viewport || !tab) return;
    const viewportRect = viewport.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    const inset = Math.min(24, viewport.clientWidth / 4);
    const leftDelta = tabRect.left - viewportRect.left - inset;
    const rightDelta = tabRect.right - viewportRect.right + inset;
    if (leftDelta < 0 || rightDelta > 0) {
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      viewport.scrollTo({
        left:
          viewport.scrollLeft +
          (leftDelta < 0 || tabRect.width > viewport.clientWidth - inset * 2
            ? leftDelta
            : rightDelta),
        behavior: reduceMotion ? "auto" : "smooth",
      });
    }
  }, []);

  useEffect(() => {
    if (activeSectionId) showSectionTab(activeSectionId);
  }, [activeSectionId, sections, showSectionTab]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const maximum = viewport.scrollWidth - viewport.clientWidth;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1;
      const next = Math.max(0, Math.min(maximum, viewport.scrollLeft + event.deltaY * unit));
      if (maximum <= 1 || Math.abs(next - viewport.scrollLeft) < 0.5) return;
      event.preventDefault();
      viewport.scrollLeft = next;
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, []);

  const handleTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      const nextIndex =
        event.key === "ArrowRight"
          ? Math.min(index + 1, sections.length - 1)
          : event.key === "ArrowLeft"
            ? Math.max(index - 1, 0)
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? sections.length - 1
                : -1;
      if (nextIndex < 0) return;
      event.preventDefault();
      const next = sections[nextIndex];
      if (!next) return;
      tabRefs.current.get(next.id)?.focus({ preventScroll: true });
      showSectionTab(next.id);
    },
    [sections, showSectionTab],
  );

  return (
    <>
      <div
        data-assistant-section-header={rowId}
        className="flex min-h-8 items-center justify-between gap-2"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">
            {intl.formatMessage({ id: "chat.assistantSectionReading.answer" })}
          </span>
          <span className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({
              id: paged
                ? "chat.assistantSectionReading.paged"
                : "chat.assistantSectionReading.continuous",
            })}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          className="shrink-0 text-ui-sm text-foreground-subtle [@media(pointer:coarse)]:min-h-11"
          onClick={onToggleMode}
        >
          {intl.formatMessage({
            id: paged
              ? "chat.assistantSectionReading.showFull"
              : "chat.assistantSectionReading.showSection",
          })}
        </Button>
      </div>
      <div
        data-assistant-section-nav={rowId}
        data-testid={testId(TID_CHAT_ASSISTANT_SECTION_NAV, String(rowId))}
        className="flex min-h-10 min-w-0 items-center gap-2 border-b border-border pb-2"
      >
        <ScrollFadeViewport
          ref={viewportRef}
          orientation="horizontal"
          className="min-w-0 flex-1 overflow-y-hidden overscroll-x-contain scrollbar-hide"
          contentClassName="items-center gap-1 px-0.5 py-0.5"
          role="tablist"
          aria-label={intl.formatMessage({ id: "chat.assistantSectionReading.navigation" })}
        >
          {sections.map((section, index) => {
            const title =
              section.title ||
              intl.formatMessage({
                id: section.id.startsWith("intro-")
                  ? "chat.assistantSectionReading.intro"
                  : "chat.assistantSectionReading.untitled",
              });
            const selected = section.id === activeSectionId;
            return (
              <Button
                key={section.id}
                ref={(element) => {
                  if (element) tabRefs.current.set(section.id, element);
                  else tabRefs.current.delete(section.id);
                }}
                type="button"
                role="tab"
                id={`assistant-section-tab-${rowId}-${index}`}
                aria-selected={selected}
                aria-controls={`assistant-section-panel-${rowId}`}
                tabIndex={selected || (activeIndex < 0 && index === 0) ? 0 : -1}
                data-assistant-section-tab={section.id}
                data-testid={testId(TID_CHAT_ASSISTANT_SECTION_TAB, `${rowId}-${index}`)}
                variant={selected ? "secondary" : "ghost"}
                className={`shrink-0 whitespace-nowrap [@media(pointer:coarse)]:min-h-11 ${selected ? "font-medium text-foreground" : "text-foreground-subtle"}`}
                onClick={() => onSelectSection(section.id)}
                onFocus={() => showSectionTab(section.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                {title}
              </Button>
            );
          })}
        </ScrollFadeViewport>
        <span
          className="shrink-0 text-ui-sm text-foreground-subtle tabular-nums"
          aria-live="polite"
        >
          {paged
            ? pageLabel
            : intl.formatMessage(
                { id: "chat.assistantSectionReading.totalSections" },
                { total: sections.length },
              )}
        </span>
      </div>
    </>
  );
}

export function AssistantSectionReadingFooter({
  rowId,
  pageLabel,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: {
  rowId: number;
  pageLabel: string;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      data-assistant-section-footer={rowId}
      className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3"
    >
      <Button
        type="button"
        variant="ghost"
        className="text-ui-sm text-foreground-subtle [@media(pointer:coarse)]:min-h-11"
        disabled={!hasPrevious}
        onClick={onPrevious}
      >
        <ChevronLeftIcon aria-hidden="true" />
        {intl.formatMessage({ id: "chat.assistantSectionReading.previous" })}
      </Button>
      <span className="text-ui-sm text-foreground-subtle tabular-nums">{pageLabel}</span>
      <Button
        type="button"
        variant="ghost"
        className="text-ui-sm text-foreground-subtle [@media(pointer:coarse)]:min-h-11"
        disabled={!hasNext}
        onClick={onNext}
      >
        {intl.formatMessage({ id: "chat.assistantSectionReading.next" })}
        <ChevronRightIcon aria-hidden="true" />
      </Button>
    </div>
  );
}
