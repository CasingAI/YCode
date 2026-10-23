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
  hasPrevious: boolean;
  hasNext: boolean;
  onSelectSection: (sectionId: string) => void;
  onToggleMode: () => void;
  onPrevious: () => void;
  onNext: () => void;
}

export function AssistantSectionReadingHeader({
  rowId,
  sections,
  activeSectionId,
  activeIndex,
  paged,
  pageLabel,
  hasPrevious,
  hasNext,
  onSelectSection,
  onToggleMode,
  onPrevious,
  onNext,
}: AssistantSectionReadingHeaderProps) {
  const { intl } = useZCodeIntl();
  const viewportRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const modeLabel = intl.formatMessage({
    id: paged ? "chat.assistantSectionReading.paged" : "chat.assistantSectionReading.continuous",
  });
  const totalSectionsLabel = intl.formatMessage(
    { id: "chat.assistantSectionReading.totalSections" },
    { total: sections.length },
  );
  const maximumPageLabel = intl.formatMessage(
    { id: "chat.assistantSectionReading.sectionCount" },
    { current: sections.length, total: sections.length },
  );

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
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <span className="shrink-0 whitespace-nowrap font-medium">
            {intl.formatMessage({ id: "chat.assistantSectionReading.answer" })}
          </span>
          <span className="min-w-0 truncate text-ui-sm text-foreground-subtle" title={modeLabel}>
            {modeLabel}
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
        className="flex min-h-10 min-w-0 items-center"
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
      </div>
      <AssistantSectionReadingPager
        rowId={rowId}
        pageLabel={paged ? pageLabel : totalSectionsLabel}
        totalSectionsLabel={totalSectionsLabel}
        maximumPageLabel={maximumPageLabel}
        hasPrevious={paged && hasPrevious}
        hasNext={paged && hasNext}
        onPrevious={onPrevious}
        onNext={onNext}
      />
    </>
  );
}

// 翻页区固定在阅读头部，连续态也保留禁用按钮，模式切换时不再插拔或移动操作入口。
function AssistantSectionReadingPager({
  rowId,
  pageLabel,
  totalSectionsLabel,
  maximumPageLabel,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: {
  rowId: number;
  pageLabel: string;
  totalSectionsLabel: string;
  maximumPageLabel: string;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <nav
      data-assistant-section-pagination={rowId}
      aria-label={intl.formatMessage({ id: "chat.assistantSectionReading.pagination" })}
      className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-border pt-1 pb-2"
    >
      <Button
        type="button"
        variant="ghost"
        className="h-auto min-h-7 min-w-0 max-w-full justify-self-start text-ui-sm whitespace-normal text-foreground-subtle [@media(pointer:coarse)]:min-h-11"
        disabled={!hasPrevious}
        onClick={onPrevious}
      >
        <ChevronLeftIcon aria-hidden="true" />
        <span className="min-w-0">
          {intl.formatMessage({ id: "chat.assistantSectionReading.previous" })}
        </span>
      </Button>
      <span className="grid text-ui-sm whitespace-nowrap text-foreground-subtle tabular-nums">
        {/* 同时保留两种计数文案的宽度，避免切换模式后翻页按钮因列宽变化而换行。 */}
        <span className="invisible col-start-1 row-start-1" aria-hidden="true">
          {totalSectionsLabel}
        </span>
        <span className="invisible col-start-1 row-start-1" aria-hidden="true">
          {maximumPageLabel}
        </span>
        <span className="col-start-1 row-start-1 text-center" aria-live="polite">
          {pageLabel}
        </span>
      </span>
      <Button
        type="button"
        variant="ghost"
        className="h-auto min-h-7 min-w-0 max-w-full justify-self-end text-ui-sm whitespace-normal text-foreground-subtle [@media(pointer:coarse)]:min-h-11"
        disabled={!hasNext}
        onClick={onNext}
      >
        <span className="min-w-0">
          {intl.formatMessage({ id: "chat.assistantSectionReading.next" })}
        </span>
        <ChevronRightIcon aria-hidden="true" />
      </Button>
    </nav>
  );
}
