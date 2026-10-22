import { useEffect, useMemo, useRef, useState } from "react";
import type { ConversationRow, SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import {
  applyConversationFindHighlights,
  applySearchResultHighlight,
  clearConversationFindHighlights,
  clearSearchResultHighlight,
  scrollConversationFindRangeIntoView,
} from "@/v4/conversationFindHighlightDom.js";
import {
  buildConversationFindIndex,
  findConversationMatchIndexByKey,
  getConversationFindMatchKey,
  resolveConversationFindActiveIndex,
  resolveSearchResultHighlightMatch,
  type ConversationFindMatch,
  type ConversationFindMatchKey,
} from "@/v4/conversationFindIndex.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import type {
  ChatSearchResultHighlightRequest,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import { useAssistantCodeCommentFeatureEnabled } from "@/AssistantCodeCommentFeatureProvider.js";

const FIND_AUTO_LOAD_ROW_LIMIT = 1200;
const SEARCH_RESULT_HIGHLIGHT_DURATION_MS = 3000;

export function shouldAttemptAssistantSearchReveal(
  requestKey: string,
  lastRequestRef: { current: string | null },
): boolean {
  // 阅读状态更新也会重跑 Find effect；同一显式搜索请求只允许展开一次。
  if (lastRequestRef.current === requestKey) return false;
  lastRequestRef.current = requestKey;
  return true;
}

interface UseConversationTimelineFindOptions {
  rootRef: React.RefObject<HTMLElement | null>;
  renderUnits: readonly ConversationTurnRenderUnit[];
  rows: readonly ConversationRow[];
  mountedRowsKey: string;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder?: () => Promise<void> | void;
  sessionPhase?: SessionPhase;
  conversationFindQuery: string;
  conversationFindActiveIndex: number;
  conversationFindNavigationRequestId: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
  /** 分节回答命中隐藏章节时，先切回全文并等待可见正文提交。 */
  onRevealAssistantRowForSearch?: (rowId: number) => boolean;
  assistantSectionReadingRevision?: number;
  scrollToUnit: (unitIndex: number) => void;
}

function normalizeSearchResultSnippet(text: string): string {
  return text
    .replace(/^\.{3}/, "")
    .replace(/\.{3}$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceTextContainsSnippet(sourceText: string, snippet: string): boolean {
  const normalizedSnippet = normalizeSearchResultSnippet(snippet).toLocaleLowerCase();
  if (!normalizedSnippet) {
    return false;
  }
  return normalizeSearchResultSnippet(sourceText).toLocaleLowerCase().includes(normalizedSnippet);
}

export function useConversationTimelineFind({
  rootRef,
  renderUnits,
  rows,
  mountedRowsKey,
  canLoadOlder,
  loadingOlder,
  onLoadOlder,
  sessionPhase,
  conversationFindQuery,
  conversationFindActiveIndex,
  conversationFindNavigationRequestId,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
  onRevealAssistantRowForSearch,
  assistantSectionReadingRevision = 0,
  scrollToUnit,
}: UseConversationTimelineFindOptions) {
  const codeCommentCardsEnabled = useAssistantCodeCommentFeatureEnabled();
  const findStable = sessionPhase !== "running" && sessionPhase !== "prewarming";
  const unitFindCacheRef = useRef(
    new Map<string, { source: ConversationFindMatch[]; loadedRowCount: number }>(),
  );
  const unitFindCacheQueryRef = useRef("");
  const conversationFindIndex = useMemo(() => {
    const query = conversationFindQuery;
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (unitFindCacheQueryRef.current !== normalizedQuery) {
      unitFindCacheRef.current.clear();
      unitFindCacheQueryRef.current = normalizedQuery;
    }
    const matches: ConversationFindMatch[] = [];
    let loadedRowCount = 0;
    // streaming delta 只会改变当前 running turn；稳定 turn 的全文索引可复用，
    // 避免每个 token 都扫描整段历史，导致长会话 renderer 主线程被持续占满。
    renderUnits.forEach((unit, unitIndex) => {
      const cacheKey = `${normalizedQuery}:${codeCommentCardsEnabled}:${unit.key}`;
      const cached = !unit.isRunning ? unitFindCacheRef.current.get(cacheKey) : undefined;
      const unitIndexResult = cached
        ? { matches: cached.source, loadedRowCount: cached.loadedRowCount }
        : buildConversationFindIndex([unit], query, {
            projectAssistantCodeComments: codeCommentCardsEnabled,
          });
      if (!unit.isRunning && !cached) {
        unitFindCacheRef.current.set(cacheKey, {
          source: unitIndexResult.matches,
          loadedRowCount: unitIndexResult.loadedRowCount,
        });
      }
      loadedRowCount += unitIndexResult.loadedRowCount;
      for (const match of unitIndexResult.matches) {
        matches.push({ ...match, globalIndex: matches.length, unitIndex });
      }
    });
    return { query: normalizedQuery, matches, matchCount: matches.length, loadedRowCount };
  }, [codeCommentCardsEnabled, conversationFindQuery, renderUnits]);
  const searchResultFindIndex = useMemo(
    () =>
      findStable && searchResultHighlightRequest
        ? buildConversationFindIndex(renderUnits, searchResultHighlightRequest.query, {
            projectAssistantCodeComments: codeCommentCardsEnabled,
          })
        : buildConversationFindIndex([], ""),
    [codeCommentCardsEnabled, findStable, renderUnits, searchResultHighlightRequest],
  );
  const [resolvedFindActiveIndex, setResolvedFindActiveIndex] = useState(-1);
  const findActiveKeyRef = useRef<ConversationFindMatchKey | null>(null);
  const lastFindQueryRef = useRef("");
  const lastExternalActiveIndexRef = useRef(conversationFindActiveIndex);
  const lastFindScrollKeyRef = useRef("");
  const lastFindHighlightScrollKeyRef = useRef("");
  const lastFindAutoLoadAttemptRef = useRef("");
  const lastSearchResultAutoLoadAttemptRef = useRef("");
  const conversationFindRevealRequestRef = useRef<string | null>(null);
  const searchResultRevealRequestRef = useRef<string | null>(null);
  const searchResultAppliedRequestRef = useRef<number | null>(null);
  const searchResultScrollRequestRef = useRef<number | null>(null);
  const searchResultCleanupTimerRef = useRef<number | undefined>(undefined);
  const activeFindMatch =
    resolvedFindActiveIndex >= 0
      ? (conversationFindIndex.matches[resolvedFindActiveIndex] ?? null)
      : null;

  useEffect(() => {
    if (!conversationFindIndex.query) {
      conversationFindRevealRequestRef.current = null;
      findActiveKeyRef.current = null;
      lastFindQueryRef.current = "";
      lastFindScrollKeyRef.current = "";
      lastFindHighlightScrollKeyRef.current = "";
      setResolvedFindActiveIndex(-1);
      clearConversationFindHighlights();
      onConversationFindMatchStateChange?.({ matchCount: 0, activeIndex: -1 });
      return;
    }

    const queryChanged = lastFindQueryRef.current !== conversationFindIndex.query;
    const externalActiveIndexChanged =
      lastExternalActiveIndexRef.current !== conversationFindActiveIndex;
    let nextActiveIndex = resolveConversationFindActiveIndex(
      conversationFindIndex,
      conversationFindActiveIndex,
    );

    if (!queryChanged && !externalActiveIndexChanged) {
      const rebasedIndex = findConversationMatchIndexByKey(
        conversationFindIndex,
        findActiveKeyRef.current,
      );
      if (rebasedIndex >= 0) {
        nextActiveIndex = rebasedIndex;
      }
    }

    const activeMatch =
      nextActiveIndex >= 0 ? (conversationFindIndex.matches[nextActiveIndex] ?? null) : null;
    findActiveKeyRef.current = getConversationFindMatchKey(activeMatch);
    lastFindQueryRef.current = conversationFindIndex.query;
    lastExternalActiveIndexRef.current = nextActiveIndex;
    setResolvedFindActiveIndex(nextActiveIndex);
    onConversationFindMatchStateChange?.({
      matchCount: conversationFindIndex.matchCount,
      activeIndex: nextActiveIndex,
    });
  }, [conversationFindActiveIndex, conversationFindIndex, onConversationFindMatchStateChange]);

  useEffect(() => {
    if (
      !findStable ||
      !conversationFindIndex.query ||
      !canLoadOlder ||
      loadingOlder ||
      rows.length >= FIND_AUTO_LOAD_ROW_LIMIT
    ) {
      return;
    }
    const attemptKey = `${conversationFindIndex.query}:${rows[0]?.rowId ?? "none"}:${rows.length}`;
    if (lastFindAutoLoadAttemptRef.current === attemptKey) {
      return;
    }
    lastFindAutoLoadAttemptRef.current = attemptKey;
    void onLoadOlder?.();
  }, [canLoadOlder, conversationFindIndex.query, findStable, loadingOlder, onLoadOlder, rows]);

  useEffect(() => {
    if (!conversationFindIndex.query || !activeFindMatch) {
      return;
    }
    const scrollKey = `${conversationFindIndex.query}:${activeFindMatch.rowId}:${activeFindMatch.rowMatchIndex}:${activeFindMatch.unitIndex}`;
    if (lastFindScrollKeyRef.current === scrollKey) {
      return;
    }
    lastFindScrollKeyRef.current = scrollKey;
    scrollToUnit(activeFindMatch.unitIndex);
  }, [activeFindMatch, conversationFindIndex.query, scrollToUnit]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !conversationFindIndex.query) {
      clearConversationFindHighlights();
      return;
    }
    if (activeFindMatch && onRevealAssistantRowForSearch) {
      const revealRequestKey = `find:${conversationFindNavigationRequestId}:${conversationFindIndex.query}:${activeFindMatch.rowId}:${activeFindMatch.rowMatchIndex}:${activeFindMatch.unitIndex}`;
      if (
        shouldAttemptAssistantSearchReveal(revealRequestKey, conversationFindRevealRequestRef) &&
        onRevealAssistantRowForSearch(activeFindMatch.rowId) === false
      ) {
        return;
      }
    }

    const frame = window.requestAnimationFrame(() => {
      const activeRange = applyConversationFindHighlights({
        root,
        query: conversationFindQuery,
        matches: conversationFindIndex.matches,
        activeMatch: activeFindMatch,
      });
      const highlightScrollKey = `${conversationFindNavigationRequestId}:${conversationFindIndex.query}:${activeFindMatch?.rowId ?? "none"}:${activeFindMatch?.rowMatchIndex ?? -1}:${activeFindMatch?.unitIndex ?? -1}`;
      if (activeRange && lastFindHighlightScrollKeyRef.current !== highlightScrollKey) {
        lastFindHighlightScrollKeyRef.current = highlightScrollKey;
        scrollConversationFindRangeIntoView(activeRange);
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    activeFindMatch,
    conversationFindIndex,
    conversationFindQuery,
    conversationFindNavigationRequestId,
    mountedRowsKey,
    onRevealAssistantRowForSearch,
    rootRef,
    assistantSectionReadingRevision,
  ]);

  useEffect(() => {
    const request = searchResultHighlightRequest;
    if (
      !request ||
      !findStable ||
      !canLoadOlder ||
      loadingOlder ||
      rows.length >= FIND_AUTO_LOAD_ROW_LIMIT
    ) {
      return;
    }
    const snippet = request.snippet?.trim();
    const shouldLoadMore = snippet
      ? !searchResultFindIndex.matches.some((match) =>
          sourceTextContainsSnippet(match.sourceText, snippet),
        )
      : searchResultFindIndex.matchCount === 0;
    if (shouldLoadMore) {
      const attemptKey = `${request.requestId}:${rows[0]?.rowId ?? "none"}:${rows.length}`;
      if (lastSearchResultAutoLoadAttemptRef.current === attemptKey) {
        return;
      }
      lastSearchResultAutoLoadAttemptRef.current = attemptKey;
      void onLoadOlder?.();
    }
  }, [
    canLoadOlder,
    findStable,
    loadingOlder,
    onLoadOlder,
    rows,
    searchResultFindIndex,
    searchResultHighlightRequest,
  ]);

  useEffect(() => {
    const request = searchResultHighlightRequest;
    if (!request || !findStable) {
      searchResultRevealRequestRef.current = null;
      clearSearchResultHighlight();
      searchResultAppliedRequestRef.current = null;
      searchResultScrollRequestRef.current = null;
      if (searchResultCleanupTimerRef.current !== undefined) {
        window.clearTimeout(searchResultCleanupTimerRef.current);
        searchResultCleanupTimerRef.current = undefined;
      }
      return;
    }

    const match = resolveSearchResultHighlightMatch(searchResultFindIndex, request);
    const snippet = request.snippet?.trim();
    const snippetFound = snippet
      ? searchResultFindIndex.matches.some((candidate) =>
          sourceTextContainsSnippet(candidate.sourceText, snippet),
        )
      : true;
    const canStillLoad = canLoadOlder && rows.length < FIND_AUTO_LOAD_ROW_LIMIT && !loadingOlder;
    if (snippet && !snippetFound && (canStillLoad || loadingOlder)) {
      return;
    }
    if (!match) {
      if (!canStillLoad) {
        onSearchResultHighlightDone?.(request.requestId);
      }
      return;
    }

    if (onRevealAssistantRowForSearch) {
      const revealRequestKey = `search-result:${request.requestId}`;
      if (
        shouldAttemptAssistantSearchReveal(revealRequestKey, searchResultRevealRequestRef) &&
        onRevealAssistantRowForSearch(match.rowId) === false
      ) {
        return;
      }
    }

    if (searchResultScrollRequestRef.current !== request.requestId) {
      searchResultScrollRequestRef.current = request.requestId;
      scrollToUnit(match.unitIndex);
    }

    if (searchResultAppliedRequestRef.current === request.requestId) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) {
        return;
      }
      const range = applySearchResultHighlight({
        root,
        query: request.query,
        match,
      });
      if (!range) {
        return;
      }
      searchResultAppliedRequestRef.current = request.requestId;
      scrollConversationFindRangeIntoView(range);
      if (searchResultCleanupTimerRef.current !== undefined) {
        window.clearTimeout(searchResultCleanupTimerRef.current);
      }
      searchResultCleanupTimerRef.current = window.setTimeout(() => {
        clearSearchResultHighlight();
        onSearchResultHighlightDone?.(request.requestId);
        searchResultCleanupTimerRef.current = undefined;
      }, SEARCH_RESULT_HIGHLIGHT_DURATION_MS);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    canLoadOlder,
    findStable,
    loadingOlder,
    mountedRowsKey,
    onSearchResultHighlightDone,
    onRevealAssistantRowForSearch,
    rootRef,
    rows,
    scrollToUnit,
    searchResultFindIndex,
    searchResultHighlightRequest,
    assistantSectionReadingRevision,
  ]);

  useEffect(() => {
    return () => {
      clearConversationFindHighlights();
      clearSearchResultHighlight();
      if (searchResultCleanupTimerRef.current !== undefined) {
        window.clearTimeout(searchResultCleanupTimerRef.current);
      }
    };
  }, []);
}
