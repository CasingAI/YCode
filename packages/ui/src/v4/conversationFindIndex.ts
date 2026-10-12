import type { AssistantTextRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import type { ChatSearchResultHighlightRequest } from "@/v4/legacyChatViewTypes.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import { projectAssistantCodeComments } from "@/lib/assistantCodeComment.js";
import {
  findMarkdownCodeRanges,
  overlapsAssistantTextRanges,
} from "@/lib/assistantDirectiveParser.js";
import {
  extractZCodeSessionCitationLinks,
  stripLegacyZCodeSessionCitationDirectives,
} from "@/lib/zcodeSessionCitation.js";

export type ConversationFindRowKind = "userInput" | "assistantText";

export interface ConversationFindMatch {
  globalIndex: number;
  unitIndex: number;
  rowId: number;
  rowKind: ConversationFindRowKind;
  rowMatchIndex: number;
  start: number;
  end: number;
  sourceText: string;
}

interface ConversationFindIndex {
  query: string;
  matches: ConversationFindMatch[];
  matchCount: number;
  loadedRowCount: number;
}

export interface ConversationFindMatchKey {
  rowId: number;
  rowKind: ConversationFindRowKind;
  rowMatchIndex: number;
}

interface ConversationFindTarget {
  unitIndex: number;
  rowId: number;
  rowKind: ConversationFindRowKind;
  text: string;
}

function normalizeConversationFindQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

function addTargetsForUnit(
  targets: ConversationFindTarget[],
  unit: ConversationTurnRenderUnit,
  unitIndex: number,
  projectCodeComments: boolean,
) {
  const latestAssistantState = unit.latestAssistantTextRow?.state;
  const projectUnitCodeComments =
    projectCodeComments &&
    (unit.isRunning ||
      latestAssistantState === "complete" ||
      latestAssistantState === "interrupted");
  for (const row of unit.visibleUserInputs) {
    targets.push(createTarget(unitIndex, row));
  }
  for (const row of unit.assistantTextRows) {
    const codeCommentProjected = projectUnitCodeComments
      ? projectAssistantCodeComments(row.text, {
          streaming: row.state === "streaming",
        }).visibleText
      : row.text;
    targets.push({
      ...createTarget(unitIndex, row),
      // 会话引用指令先剥离再进索引：code-comment 投影之后做，避免投影改写位移。
      text: stripSessionCitationsForFindIndex(codeCommentProjected),
    });
  }
}

function createTarget(
  unitIndex: number,
  row: UserInputRow | AssistantTextRow,
): ConversationFindTarget {
  return {
    unitIndex,
    rowId: row.rowId,
    rowKind: row.kind,
    text: row.text,
  };
}

/**
 * 搜索索引里的 ycode 会话链接剥离：URL（sessionId/query 语法）不应参与
 * 全文搜索与跳转高亮匹配——用户搜的是正文内容，不是内部链接语法。
 * 只保留链接文本（可搜到引用所指），URL 丢掉；代码块内的不受影响。
 * 遗留 `:::zcode-session-citation{...}` 指令块同样剥离成其文本片段（没有 text 退 title，
 * 都没有整段丢弃），永不把指令原文带进查找索引；代码块内的协议示例受保护。
 */
function stripSessionCitationsForFindIndex(text: string): string {
  let result = text;
  if (result.includes("ycode://session/open")) {
    const protectedRanges = findMarkdownCodeRanges(result);
    const citations = extractZCodeSessionCitationLinks(result).filter(
      (citation) => !overlapsAssistantTextRanges(citation.start, citation.end, protectedRanges),
    );
    for (const citation of [...citations].reverse()) {
      const replacement = citation.text.trim();
      result = `${result.slice(0, citation.start)}${replacement}${result.slice(citation.end)}`;
    }
  }
  // ycode 剥离不产生新的指令块；对改写后的正文做遗留指令块剥离。
  return stripLegacyZCodeSessionCitationDirectives(result);
}

export function buildConversationFindIndex(
  units: readonly ConversationTurnRenderUnit[],
  query: string,
  options: { projectAssistantCodeComments?: boolean } = {},
): ConversationFindIndex {
  const normalizedQuery = normalizeConversationFindQuery(query);
  const targets: ConversationFindTarget[] = [];
  units.forEach((unit, unitIndex) =>
    addTargetsForUnit(targets, unit, unitIndex, options.projectAssistantCodeComments === true),
  );

  if (!normalizedQuery) {
    return {
      query: normalizedQuery,
      matches: [],
      matchCount: 0,
      loadedRowCount: targets.length,
    };
  }

  const matches: ConversationFindMatch[] = [];
  for (const target of targets) {
    const normalizedText = target.text.toLocaleLowerCase();
    let searchStart = 0;
    let rowMatchIndex = 0;
    while (searchStart < normalizedText.length) {
      const matchIndex = normalizedText.indexOf(normalizedQuery, searchStart);
      if (matchIndex === -1) {
        break;
      }
      matches.push({
        globalIndex: matches.length,
        unitIndex: target.unitIndex,
        rowId: target.rowId,
        rowKind: target.rowKind,
        rowMatchIndex,
        start: matchIndex,
        end: matchIndex + normalizedQuery.length,
        sourceText: target.text,
      });
      rowMatchIndex += 1;
      searchStart = matchIndex + normalizedQuery.length;
    }
  }

  return {
    query: normalizedQuery,
    matches,
    matchCount: matches.length,
    loadedRowCount: targets.length,
  };
}

export function getConversationFindMatchKey(
  match: ConversationFindMatch | null | undefined,
): ConversationFindMatchKey | null {
  if (!match) {
    return null;
  }
  return {
    rowId: match.rowId,
    rowKind: match.rowKind,
    rowMatchIndex: match.rowMatchIndex,
  };
}

export function findConversationMatchIndexByKey(
  index: ConversationFindIndex,
  key: ConversationFindMatchKey | null | undefined,
): number {
  if (!key) {
    return -1;
  }
  return index.matches.findIndex(
    (match) =>
      match.rowId === key.rowId &&
      match.rowKind === key.rowKind &&
      match.rowMatchIndex === key.rowMatchIndex,
  );
}

export function resolveConversationFindActiveIndex(
  index: ConversationFindIndex,
  preferredIndex: number,
): number {
  if (index.matchCount === 0) {
    return -1;
  }
  if (preferredIndex >= 0 && preferredIndex < index.matchCount) {
    return preferredIndex;
  }
  return 0;
}

function normalizeSearchResultProbeText(text: string): string {
  return text
    .replace(/^\.{3}/, "")
    .replace(/\.{3}$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function includesProbe(sourceText: string, probe: string): boolean {
  const normalizedSource = normalizeSearchResultProbeText(sourceText).toLocaleLowerCase();
  const normalizedProbe = normalizeSearchResultProbeText(probe).toLocaleLowerCase();
  return normalizedProbe.length > 0 && normalizedSource.includes(normalizedProbe);
}

export function resolveSearchResultHighlightMatch(
  index: ConversationFindIndex,
  request: ChatSearchResultHighlightRequest,
): ConversationFindMatch | null {
  if (index.matchCount === 0) {
    return null;
  }

  const snippet = request.snippet?.trim();
  if (snippet) {
    const snippetMatch = index.matches.find((match) => includesProbe(match.sourceText, snippet));
    if (snippetMatch) {
      return snippetMatch;
    }
  }

  const preferredIndex = request.snippetIndex ?? 0;
  return index.matches[preferredIndex] ?? index.matches[0] ?? null;
}
