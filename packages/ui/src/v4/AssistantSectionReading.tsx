import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  normalizeAssistantSectionHeadingText,
  type AssistantSectionDocument,
} from "@/lib/assistantSectionReading.js";
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
import {
  AssistantSectionReadingFooter,
  AssistantSectionReadingHeader,
} from "@/v4/AssistantSectionReadingNavigation.js";
import { TIMELINE_TOP_OCCLUSION_PX } from "@/v4/timelineTopOcclusion.js";

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
    // 头部吸顶后 top 已被钳位；新增占位只能按盒子实际高度补偿，不能与正文 top 相减。
    const shiftPx = navigation.getBoundingClientRect().height;
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
        if (
          normalizeAssistantSectionHeadingText(heading.textContent ?? "") !==
          normalizeAssistantSectionHeadingText(section.title)
        ) {
          continue;
        }
        heading.dataset.assistantSectionStart = section.id;
        break;
      }
    }
  }, [document, mode, markdown]);

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

  const pageLabel = intl.formatMessage(
    { id: "chat.assistantSectionReading.sectionCount" },
    { current: activeIndex + 1, total: sections.length },
  );

  return (
    <div className="w-full min-w-0" data-assistant-section-origin={document ? rowId : undefined}>
      <div
        ref={navigationRef}
        className={
          document
            ? "sticky z-10 min-w-0 animate-in bg-background pt-1 pb-4 fade-in-0 duration-[160ms] motion-reduce:animate-none"
            : "hidden"
        }
        style={
          document
            ? {
                top: `calc(${TIMELINE_TOP_OCCLUSION_PX}px - var(--timeline-virtual-row-offset, 0px))`,
              }
            : undefined
        }
      >
        {document ? (
          <AssistantSectionReadingHeader
            rowId={rowId}
            sections={sections}
            activeSectionId={activeSectionId}
            activeIndex={activeIndex}
            paged={mode === "paged"}
            pageLabel={pageLabel}
            onSelectSection={selectSection}
            onToggleMode={mode === "paged" ? selectWholeDocument : returnToCurrentSection}
          />
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
      {document && mode === "paged" ? (
        <AssistantSectionReadingFooter
          rowId={rowId}
          pageLabel={pageLabel}
          hasPrevious={activeIndex > 0}
          hasNext={activeIndex < sections.length - 1}
          onPrevious={() => selectRelativeSection(-1)}
          onNext={() => selectRelativeSection(1)}
        />
      ) : null}
    </div>
  );
}
