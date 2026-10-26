import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
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
  hasExceededAssistantSectionDragThreshold,
  resolveAssistantSectionKeyboardIntent,
  shouldAdvanceAssistantSectionFromClick,
  type AssistantSectionPointerPosition,
} from "@/v4/AssistantSectionReadingInteraction.js";
import { useAssistantSectionMinHeight } from "@/v4/AssistantSectionReadingLayout.js";
import { AssistantSectionReadingHeader } from "@/v4/AssistantSectionReadingNavigation.js";
import type { AssistantSectionReadingLayout } from "@/v4/conversationRowContext.js";

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
  preserveReadingPosition?: (layout: AssistantSectionReadingLayout) => void;
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
  const storedActiveIndex = sections.findIndex((section) => section.id === activeSectionId);
  // 分页态始终有可读章节；store 尚未初始化或活动节为空时回退首节，避免空白卡片。
  const displayIndex = storedActiveIndex >= 0 ? storedActiveIndex : sections.length > 0 ? 0 : -1;
  const activeSection = displayIndex >= 0 ? sections[displayIndex] : undefined;
  const paged = mode === "paged" && document !== undefined && activeSection !== undefined;
  const panelRef = useRef<HTMLDivElement>(null);
  const navigationRef = useRef<HTMLDivElement>(null);
  const pointerStartRef = useRef<AssistantSectionPointerPosition | null>(null);
  const dragExceededRef = useRef(false);
  const selectionCollapsedAtPointerDownRef = useRef(true);
  const measuredMinHeight = useAssistantSectionMinHeight({ enabled: paged, getScrollRoot });

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
    const navigation = navigationRef.current;
    if (!navigation) return;
    // Live 转入历史虚拟行会重挂；局部 ref 无法判断是否已补偿，交给 Timeline 按完整身份结算。
    preserveReadingPosition?.({
      scopeKey,
      rowKey,
      rowId,
      documentVersion: document?.version ?? null,
      headerHeightPx: document ? navigation.getBoundingClientRect().height : 0,
      preserveContinuousPosition: document !== undefined && mode === "continuous",
      navigationElement: navigation,
    });
  }, [document, mode, preserveReadingPosition, rowId, rowKey, scopeKey]);

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
        // 首节可能包含总标题；偏移 0 的锚点由正文面板承载，不能落到内部章节标题。
        if (section.startOffset !== 0) heading.dataset.assistantSectionStart = section.id;
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
      const nextIndex = displayIndex < 0 ? (delta > 0 ? 0 : -1) : displayIndex + delta;
      const next = sections[nextIndex];
      if (next) selectSection(next.id);
    },
    [displayIndex, sections, selectSection],
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

  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!paged) return;
      pointerStartRef.current = { x: event.clientX, y: event.clientY };
      dragExceededRef.current = false;
      // 捕获阶段仍能看到点击前的选区；默认动作会在本次 pointerdown 后折叠旧选区。
      selectionCollapsedAtPointerDownRef.current = window.getSelection()?.isCollapsed ?? true;
    },
    [paged],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!paged || dragExceededRef.current) return;
      if (
        hasExceededAssistantSectionDragThreshold(pointerStartRef.current, {
          x: event.clientX,
          y: event.clientY,
        })
      ) {
        dragExceededRef.current = true;
      }
    },
    [paged],
  );

  const handlePointerEnd = useCallback(() => {
    // 保留 dragExceededRef 给随后的 click 判定；下一次按下时再重置。
    pointerStartRef.current = null;
  }, []);

  const handleCardClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!paged) return;
      const selection = typeof window === "undefined" ? null : window.getSelection();
      const advance = shouldAdvanceAssistantSectionFromClick({
        targetIsCard: event.target === event.currentTarget,
        clickCount: event.detail,
        selectionCollapsed: selection?.isCollapsed ?? true,
        selectionCollapsedAtPointerDown: selectionCollapsedAtPointerDownRef.current,
        dragExceeded: dragExceededRef.current,
      });
      dragExceededRef.current = false;
      selectionCollapsedAtPointerDownRef.current = true;
      if (!advance) return;
      // 让空白区获得卡片焦点，随后的局部方向键无需先点头部按钮。
      event.currentTarget.focus({ preventScroll: true });
      selectRelativeSection(1);
    },
    [paged, selectRelativeSection],
  );

  const handleCardKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!paged) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      // 目录通过 portal 渲染，React 事件仍会冒泡回卡片；目录内部的 Page/方向键交给菜单自己处理。
      const insideContent =
        target.closest("[data-assistant-section-content]") !== null ||
        target.closest("[data-assistant-section-toc], [role='menu']") !== null ||
        target.closest("input, textarea, select, [contenteditable='true']") !== null;
      const intent = resolveAssistantSectionKeyboardIntent({
        key: event.key,
        targetInsideContent: insideContent,
        defaultPrevented: event.defaultPrevented,
        hasModifier: event.altKey || event.ctrlKey || event.metaKey || event.shiftKey,
      });
      if (intent === null) return;
      event.preventDefault();
      selectRelativeSection(intent);
    },
    [paged, selectRelativeSection],
  );

  const pageLabel = intl.formatMessage(
    { id: "chat.assistantSectionReading.sectionCount" },
    { current: displayIndex + 1, total: sections.length },
  );
  const maximumPageLabel = intl.formatMessage(
    { id: "chat.assistantSectionReading.sectionCount" },
    { current: sections.length, total: sections.length },
  );
  const sectionPositionLabel = intl.formatMessage(
    { id: "chat.assistantSectionReading.sectionPosition" },
    { current: displayIndex + 1, total: sections.length },
  );
  const answerLabel = intl.formatMessage({ id: "chat.assistantSectionReading.answer" });
  const entryLabel = intl.formatMessage({ id: "chat.assistantSectionReading.showSection" });
  const emphasis = paged ? activeSection?.presentation?.emphasis : undefined;
  const emphasisClassName =
    emphasis === "xl"
      ? "[&_p]:text-ui-xl [&_p]:leading-relaxed"
      : emphasis === "lg"
        ? "[&_p]:text-ui-lg [&_p]:leading-relaxed"
        : undefined;

  return (
    <div className="w-full min-w-0" data-assistant-section-origin={document ? rowId : undefined}>
      {paged && activeSection ? (
        <div
          data-assistant-section-card={rowId}
          role="group"
          aria-label={answerLabel}
          tabIndex={-1}
          onClick={handleCardClick}
          onKeyDown={handleCardKeyDown}
          onPointerDownCapture={handlePointerDownCapture}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          style={measuredMinHeight === null ? undefined : { minHeight: `${measuredMinHeight}px` }}
          className="w-full min-w-0 rounded-xl border border-card-border bg-card pb-4 shadow-sm min-h-[clamp(160px,40dvh,320px)] animate-in fade-in-0 duration-[160ms] motion-reduce:animate-none sm:min-h-[clamp(220px,46dvh,480px)] @container/assistant-reading focus:outline-none focus-visible:outline-none"
        >
          <AssistantSectionReadingHeader
            rowId={rowId}
            headerRef={navigationRef}
            sections={sections}
            activeSectionId={activeSection.id}
            activeIndex={displayIndex}
            pageLabel={pageLabel}
            maximumPageLabel={maximumPageLabel}
            sectionPositionLabel={sectionPositionLabel}
            hasPrevious={displayIndex > 0}
            hasNext={displayIndex < sections.length - 1}
            onSelectSection={selectSection}
            onToggleMode={selectWholeDocument}
            onPrevious={() => selectRelativeSection(-1)}
            onNext={() => selectRelativeSection(1)}
          />
          <div
            ref={panelRef}
            id={`assistant-section-panel-${rowId}`}
            role="region"
            aria-labelledby={`assistant-section-title-${rowId}`}
            data-conversation-selectable="true"
            className="w-full px-3 pt-2 text-ui-base sm:px-4"
          >
            <div
              key={activeSection.id}
              data-assistant-section-start={activeSection.id}
              data-assistant-section-content="true"
              data-assistant-section-emphasis={emphasis}
              className={cn(
                "animate-in fade-in-0 duration-[110ms] motion-reduce:animate-none",
                emphasisClassName,
              )}
            >
              {renderMarkdown(activeSection.markdown, false)}
            </div>
          </div>
        </div>
      ) : (
        <>
          {document ? (
            <div
              ref={navigationRef}
              data-assistant-section-entry={rowId}
              className="flex w-full min-w-0 pb-1"
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-assistant-section-entry-button={rowId}
                className="rounded-lg px-0 text-ui-sm text-foreground-subtle hover:bg-transparent hover:text-foreground focus-visible:bg-hover focus-visible:text-foreground [@media(pointer:coarse)]:min-h-11"
                onClick={returnToCurrentSection}
              >
                {entryLabel}
              </Button>
            </div>
          ) : null}
          <div
            ref={panelRef}
            id={`assistant-section-panel-${rowId}`}
            role={document ? "region" : undefined}
            aria-label={document ? answerLabel : undefined}
            data-conversation-selectable="true"
            data-assistant-section-start={
              mode === "full" && sections[0]?.startOffset === 0 ? sections[0].id : undefined
            }
            className="w-full text-ui-base"
          >
            {renderMarkdown(markdown, streaming)}
          </div>
        </>
      )}
    </div>
  );
}
