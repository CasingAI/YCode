import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronLeftIcon, ChevronRightIcon, ListCollapseIcon, ListIcon } from "lucide-react";
import {
  TID_CHAT_ASSISTANT_SECTION_NAV,
  TID_CHAT_ASSISTANT_SECTION_TAB,
  testId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { AssistantSectionDocument } from "@/lib/assistantSectionReading.js";
import {
  createAssistantSectionReadingRowKey,
  getAssistantSectionReadingRowRevision,
  getAssistantSectionReadingState,
  initializeAssistantSectionReading,
  selectAssistantReadingSection,
  setAssistantReadingMode,
  subscribeAssistantSectionReadingRow,
  wasAssistantSectionRowPresented,
  type AssistantSectionReadingMode,
} from "@/store/assistantSectionReadingStore.js";

interface AssistantSectionReadingProps {
  rowId: number;
  entityId?: string;
  turnId: string;
  scopeKey: string;
  document?: AssistantSectionDocument;
  markdown: string;
  streaming: boolean;
  turnRunning: boolean;
  getScrollRoot?: () => HTMLElement | null;
  preserveReadingPosition?: (rowId: number, shiftPx: number) => void;
  renderMarkdown: (markdown: string, streaming: boolean) => ReactNode;
}

export function AssistantSectionReading({
  rowId,
  entityId,
  turnId,
  scopeKey,
  document,
  markdown,
  streaming,
  turnRunning,
  getScrollRoot,
  preserveReadingPosition,
  renderMarkdown,
}: AssistantSectionReadingProps) {
  const { intl } = useZCodeIntl();
  const rowKey = useMemo(
    () => createAssistantSectionReadingRowKey({ turnId, rowId, entityId }),
    [entityId, rowId, turnId],
  );
  const subscribe = useCallback(
    (listener: () => void) => subscribeAssistantSectionReadingRow(scopeKey, rowKey, listener),
    [rowKey, scopeKey],
  );
  const readRevision = useCallback(
    () => getAssistantSectionReadingRowRevision(scopeKey, rowKey),
    [rowKey, scopeKey],
  );
  useSyncExternalStore(subscribe, readRevision, readRevision);
  const state = getAssistantSectionReadingState(scopeKey, rowKey);
  const wasPresented = wasAssistantSectionRowPresented(scopeKey, rowKey);
  const initialMode: AssistantSectionReadingMode = wasPresented ? "continuous" : "paged";
  const stateVersionMatches = document !== undefined && state?.version === document.version;
  const mode: AssistantSectionReadingMode = !document
    ? "full"
    : stateVersionMatches && state
      ? state.mode
      : state
        ? state.mode === "continuous"
          ? "continuous"
          : "full"
        : initialMode;
  const sections = document?.sections ?? [];
  const activeSectionId = !document
    ? null
    : stateVersionMatches && state
      ? state.activeSectionId
      : state
        ? null
        : wasPresented
          ? null
          : (sections[0]?.id ?? null);
  const activeIndex = sections.findIndex((section) => section.id === activeSectionId);
  const activeSection = activeIndex >= 0 ? sections[activeIndex] : undefined;
  const panelRef = useRef<HTMLDivElement>(null);
  const navigationRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const turnWasRunningRef = useRef(turnRunning);
  const previousDocumentRef = useRef(document);

  useEffect(() => {
    if (!document) return;
    initializeAssistantSectionReading({
      scopeKey,
      rowKey,
      rowId,
      version: document.version,
      firstSectionId: document.sections[0]?.id ?? "",
    });
  }, [document, rowId, rowKey, scopeKey]);

  useLayoutEffect(() => {
    if (turnRunning) turnWasRunningRef.current = true;
    const previousDocument = previousDocumentRef.current;
    previousDocumentRef.current = document;
    if (
      previousDocument !== undefined ||
      !document ||
      mode !== "continuous" ||
      turnWasRunningRef.current === false
    ) {
      return;
    }

    const navigation = navigationRef.current;
    const panel = panelRef.current;
    if (!navigation || !panel) return;
    // 完成态工具栏新增在正文上方；用两者实际间距交给 Timeline 补偿，避免锚定整轮起点。
    const shiftPx = panel.getBoundingClientRect().top - navigation.getBoundingClientRect().top;
    if (shiftPx > 0) preserveReadingPosition?.(rowId, shiftPx);
  }, [document, mode, preserveReadingPosition, rowId, turnRunning]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || mode !== "full" || !document) return;
    const expectedHeadings = document.sections.filter((section) => section.title.length > 0);
    const candidates = Array.from(
      panel.querySelectorAll<HTMLElement>(`h${document.splitHeadingDepth}`),
    ).filter((heading) => !heading.closest("blockquote, li"));
    let candidateIndex = 0;
    for (const section of expectedHeadings) {
      while (candidateIndex < candidates.length) {
        const heading = candidates[candidateIndex]!;
        candidateIndex += 1;
        if (heading.textContent?.replace(/\s+/g, " ").trim() !== section.title) continue;
        heading.dataset.assistantSectionStart = section.id;
        break;
      }
    }
  }, [document, mode, markdown]);

  useEffect(() => {
    if (!document || !activeSectionId) return;
    const viewport = viewportRef.current;
    const tab = tabRefs.current.get(activeSectionId);
    if (!viewport || !tab) return;
    const viewportRect = viewport.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    const leftDelta = tabRect.left - viewportRect.left;
    const rightDelta = tabRect.right - viewportRect.right;
    if (leftDelta < 0 || rightDelta > 0) {
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      viewport.scrollTo({
        left: viewport.scrollLeft + (leftDelta < 0 ? leftDelta : rightDelta),
        behavior: reduceMotion ? "auto" : "smooth",
      });
    }
  }, [activeSectionId, document]);

  const selectSection = useCallback(
    (sectionId: string) => {
      if (!document) return;
      window.getSelection()?.removeAllRanges();
      selectAssistantReadingSection({
        scopeKey,
        rowKey,
        rowId,
        sectionId,
        version: document.version,
      });
    },
    [document, rowId, rowKey, scopeKey],
  );

  const selectRelativeSection = useCallback(
    (delta: -1 | 1) => {
      const nextIndex = activeIndex < 0 ? (delta > 0 ? 0 : -1) : activeIndex + delta;
      const next = sections[nextIndex];
      if (next) selectSection(next.id);
    },
    [activeIndex, sections, selectSection],
  );

  const selectWholeDocument = useCallback(() => {
    if (!document) return;
    window.getSelection()?.removeAllRanges();
    const root = getScrollRoot?.();
    const panel = panelRef.current;
    const anchor =
      activeSection && panel
        ? panel.dataset.assistantSectionStart === activeSection.id
          ? panel
          : Array.from(panel.querySelectorAll<HTMLElement>("[data-assistant-section-start]")).find(
              (element) => element.dataset.assistantSectionStart === activeSection.id,
            )
        : undefined;
    const anchorOffset =
      root && anchor
        ? anchor.getBoundingClientRect().top - root.getBoundingClientRect().top
        : undefined;
    setAssistantReadingMode({
      scopeKey,
      rowKey,
      rowId,
      mode: "full",
      version: document.version,
      anchorOffset,
    });
  }, [activeSection, document, getScrollRoot, rowId, rowKey, scopeKey]);

  const returnToCurrentSection = useCallback(() => {
    const target = activeSection ?? sections[0];
    if (target) selectSection(target.id);
  }, [activeSection, sections, selectSection]);

  const handleTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      const nextIndex =
        event.key === "ArrowRight"
          ? (index + 1) % sections.length
          : event.key === "ArrowLeft"
            ? (index - 1 + sections.length) % sections.length
            : -1;
      if (nextIndex < 0) return;
      event.preventDefault();
      const next = sections[nextIndex];
      if (!next) return;
      selectSection(next.id);
      tabRefs.current.get(next.id)?.focus();
    },
    [sections, selectSection],
  );

  return (
    <div className="w-full min-w-0">
      <div
        ref={navigationRef}
        className={
          document
            ? "mb-2 flex min-w-0 animate-in items-center gap-2 fade-in-0 duration-[160ms] motion-reduce:animate-none"
            : "hidden"
        }
        data-assistant-section-nav={document ? rowId : undefined}
        data-testid={document ? testId(TID_CHAT_ASSISTANT_SECTION_NAV, String(rowId)) : undefined}
      >
        {document ? (
          <>
            <ScrollFadeViewport
              ref={viewportRef}
              orientation="horizontal"
              className="min-w-0 flex-1"
              contentClassName="items-center gap-1 pr-6"
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
                    title={title}
                    data-assistant-section-tab={section.id}
                    data-testid={testId(TID_CHAT_ASSISTANT_SECTION_TAB, `${rowId}-${index}`)}
                    variant={selected ? "secondary" : "ghost"}
                    size="sm"
                    className="max-w-56 min-w-0 justify-start truncate"
                    onClick={() => selectSection(section.id)}
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                  >
                    <span className="truncate">{title}</span>
                  </Button>
                );
              })}
            </ScrollFadeViewport>
            <span className="shrink-0 text-ui-sm text-foreground-subtle" aria-live="polite">
              {intl.formatMessage(
                { id: "chat.assistantSectionReading.sectionCount" },
                {
                  current: activeIndex < 0 ? "—" : activeIndex + 1,
                  total: sections.length,
                },
              )}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={intl.formatMessage({
                id:
                  mode === "paged"
                    ? "chat.assistantSectionReading.showFull"
                    : "chat.assistantSectionReading.showSection",
              })}
              onClick={mode === "paged" ? selectWholeDocument : returnToCurrentSection}
              className="shrink-0"
            >
              {mode === "paged" ? (
                <>
                  <ListIcon aria-hidden="true" />
                  <span className="hidden @md/conversation:inline">
                    {intl.formatMessage({ id: "chat.assistantSectionReading.showFull" })}
                  </span>
                </>
              ) : (
                <>
                  <ListCollapseIcon aria-hidden="true" />
                  <span className="hidden @md/conversation:inline">
                    {intl.formatMessage({ id: "chat.assistantSectionReading.showSection" })}
                  </span>
                </>
              )}
            </Button>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={intl.formatMessage({ id: "chat.assistantSectionReading.previous" })}
                disabled={activeIndex <= 0}
                onClick={() => selectRelativeSection(-1)}
              >
                <ChevronLeftIcon aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={intl.formatMessage({ id: "chat.assistantSectionReading.next" })}
                disabled={activeIndex >= sections.length - 1}
                onClick={() => selectRelativeSection(1)}
              >
                <ChevronRightIcon aria-hidden="true" />
              </Button>
            </div>
          </>
        ) : null}
      </div>
      <div
        ref={panelRef}
        id={`assistant-section-panel-${rowId}`}
        role="tabpanel"
        aria-labelledby={
          activeIndex < 0 ? undefined : `assistant-section-tab-${rowId}-${activeIndex}`
        }
        data-conversation-selectable="true"
        data-assistant-section-start={
          mode === "full" && activeSection?.title === "" ? activeSection.id : undefined
        }
        className="w-full text-ui-base"
      >
        {mode === "paged" && activeSection && document ? (
          <div
            key={activeSection.id}
            data-assistant-section-start={activeSection.id}
            className="animate-in fade-in-0 duration-[110ms] motion-reduce:animate-none"
          >
            {renderMarkdown(activeSection.markdown, false)}
          </div>
        ) : (
          renderMarkdown(markdown, streaming)
        )}
      </div>
    </div>
  );
}
