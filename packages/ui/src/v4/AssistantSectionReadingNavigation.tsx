import { useRef, type RefObject } from "react";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, ListIcon } from "lucide-react";
import {
  TID_CHAT_ASSISTANT_SECTION_NAV,
  TID_CHAT_ASSISTANT_SECTION_TAB,
  testId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TIMELINE_TOP_OCCLUSION_PX } from "@/v4/timelineTopOcclusion.js";

interface SectionNavigationItem {
  id: string;
  title: string;
}

interface AssistantSectionReadingHeaderProps {
  rowId: number;
  headerRef: RefObject<HTMLDivElement | null>;
  sections: readonly SectionNavigationItem[];
  activeSectionId: string | null;
  activeIndex: number;
  pageLabel: string;
  maximumPageLabel: string;
  sectionPositionLabel: string;
  hasPrevious: boolean;
  hasNext: boolean;
  onSelectSection: (sectionId: string) => void;
  onToggleMode: () => void;
  onPrevious: () => void;
  onNext: () => void;
}

export function AssistantSectionReadingHeader({
  rowId,
  headerRef,
  sections,
  activeSectionId,
  activeIndex,
  pageLabel,
  maximumPageLabel,
  sectionPositionLabel,
  hasPrevious,
  hasNext,
  onSelectSection,
  onToggleMode,
  onPrevious,
  onNext,
}: AssistantSectionReadingHeaderProps) {
  const { intl } = useZCodeIntl();
  const tocTriggerRef = useRef<HTMLButtonElement>(null);
  const navigationLabel = intl.formatMessage({ id: "chat.assistantSectionReading.navigation" });
  const tocLabel = intl.formatMessage({ id: "chat.assistantSectionReading.toc" });
  const previousLabel = intl.formatMessage({ id: "chat.assistantSectionReading.previous" });
  const nextLabel = intl.formatMessage({ id: "chat.assistantSectionReading.next" });
  const showFullLabel = intl.formatMessage({ id: "chat.assistantSectionReading.showFull" });
  const activeSection = sections[activeIndex];
  const activeTitle = activeSection
    ? displaySectionTitle(activeSection, intl)
    : intl.formatMessage({ id: "chat.assistantSectionReading.untitled" });

  const controlClassName =
    "shrink-0 rounded-lg px-1.5 text-ui-sm text-foreground-subtle hover:text-foreground focus-visible:bg-hover focus-visible:text-foreground [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";

  return (
    <div
      ref={headerRef}
      data-assistant-section-header={rowId}
      data-testid={testId(TID_CHAT_ASSISTANT_SECTION_NAV, String(rowId))}
      role="group"
      aria-label={navigationLabel}
      className="sticky z-10 flex min-h-9 min-w-0 items-center gap-1 rounded-t-xl border-b border-border bg-card px-3 py-1 sm:px-4 [@media(pointer:coarse)]:min-h-12"
      style={{
        top: `calc(${TIMELINE_TOP_OCCLUSION_PX}px - var(--timeline-virtual-row-offset, 0px))`,
      }}
    >
      <div className="min-w-0 flex-1" data-assistant-section-title={rowId}>
        <ScrollFadeViewport
          orientation="horizontal"
          className="min-w-0 overflow-y-hidden scrollbar-hide"
          contentClassName="items-center"
        >
          <span
            id={`assistant-section-title-${rowId}`}
            title={activeTitle}
            className="whitespace-nowrap text-ui-base font-medium"
          >
            {activeTitle}
          </span>
        </ScrollFadeViewport>
      </div>

      <span
        data-assistant-section-count={rowId}
        role="status"
        aria-live="polite"
        aria-label={sectionPositionLabel}
        className="inline-grid shrink-0 text-ui-sm whitespace-nowrap text-foreground-subtle tabular-nums"
      >
        {/* 用最大页码占位，切换章节时页码宽度和右侧按钮位置保持稳定。 */}
        <span className="invisible col-start-1 row-start-1 px-0.5" aria-hidden="true">
          {maximumPageLabel}
        </span>
        <span className="col-start-1 row-start-1 px-0.5 text-center">{pageLabel}</span>
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={tocTriggerRef}
            type="button"
            variant="ghost"
            size="sm"
            data-assistant-section-toc-trigger={rowId}
            aria-label={tocLabel}
            title={tocLabel}
            className={controlClassName}
          >
            <ListIcon aria-hidden="true" />
            <span className="hidden @min-[640px]/assistant-reading:inline">{tocLabel}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          data-assistant-section-toc={rowId}
          className="w-72 max-w-(--radix-dropdown-menu-content-available-width)"
          onCloseAutoFocus={(event) => {
            // Esc、选中章节或点击外部关闭后都回到目录入口，避免焦点落回页面根。
            event.preventDefault();
            tocTriggerRef.current?.focus({ preventScroll: true });
          }}
        >
          {sections.map((section, index) => {
            const selected = section.id === activeSectionId;
            return (
              <DropdownMenuItem
                key={section.id}
                data-assistant-section-toc-item={section.id}
                data-testid={testId(TID_CHAT_ASSISTANT_SECTION_TAB, `${rowId}-${index}`)}
                aria-current={selected ? "page" : undefined}
                className="min-w-0 items-start whitespace-normal break-words [@media(pointer:coarse)]:min-h-11"
                onSelect={() => onSelectSection(section.id)}
              >
                <span className="min-w-0 flex-1">{displaySectionTitle(section, intl)}</span>
                {selected ? (
                  <CheckIcon
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0 text-foreground-subtle"
                  />
                ) : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-assistant-section-previous={rowId}
        aria-label={previousLabel}
        title={previousLabel}
        className={controlClassName}
        disabled={!hasPrevious}
        onClick={onPrevious}
      >
        <ChevronLeftIcon aria-hidden="true" />
        <span className="hidden @min-[640px]/assistant-reading:inline">{previousLabel}</span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-assistant-section-next={rowId}
        aria-label={nextLabel}
        title={nextLabel}
        className={controlClassName}
        disabled={!hasNext}
        onClick={onNext}
      >
        <span className="hidden @min-[640px]/assistant-reading:inline">{nextLabel}</span>
        <ChevronRightIcon aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-assistant-section-full={rowId}
        title={showFullLabel}
        className={controlClassName}
        onClick={onToggleMode}
      >
        {showFullLabel}
      </Button>
    </div>
  );
}

function displaySectionTitle(
  section: SectionNavigationItem,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  if (section.title) return section.title;
  return intl.formatMessage({
    id: section.id.startsWith("intro-")
      ? "chat.assistantSectionReading.intro"
      : "chat.assistantSectionReading.untitled",
  });
}
