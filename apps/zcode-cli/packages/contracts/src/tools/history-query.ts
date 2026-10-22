// ============================================================
// History 查询装配 — List/Read/Search 的唯一扫描/过滤/分页实现
// ============================================================
// handler 内存回退与 SQLite 只读旁路工作线程共用。只依赖 HistoryStoreReads
//（SessionStorePort 的读子集），不认识 SQLite。坐标纯函数见 history-projection.ts。
// 详见 docs/specs/session-history-tools.md。

import type { SessionId } from "../interfaces/shared.js";
import type {
  ListSessionsInput,
  MessageWithParts,
  SessionInfo,
} from "../interfaces/session-store.port.js";
import {
  HISTORY_DEFAULT_LIST_DAYS,
  HISTORY_DEFAULT_MAX_CHARS,
  HISTORY_DEFAULT_SEARCH_DAYS,
  HISTORY_LIST_SESSION_SCAN_CAP,
  type HistoryListInput,
  type HistoryListOutput,
  type HistoryListScopeFacts,
  type HistoryReadInput,
  type HistoryReadOutput,
  type HistorySearchHit,
  type HistorySearchInput,
  type HistorySearchOutput,
  type HistorySessionSummary,
} from "./history.js";
import type { IsolatedHistoryJob, IsolatedHistoryJobResult } from "./history-isolated-job.js";
import {
  buildTurns,
  isHiddenHistorySession,
  makeSnippet,
  parseHistoryKeywords,
  renderTurnsPage,
} from "./history-projection.js";

const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_SEARCH_LIMIT = 20;

/** SessionStorePort 上 History 三件套真正用到的读方法。 */
export interface HistoryStoreReads {
  listSessions(input?: ListSessionsInput): Promise<SessionInfo[]>;
  getSession(sessionID: SessionId): Promise<SessionInfo | null>;
  messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]>;
  sessionMessageCounts?(input: { sessionIDs: SessionId[] }): Promise<Record<string, number>>;
}

export function throwIfHistoryQueryAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("History query aborted", "AbortError");
}

export function buildHistoryListScopeNote(input: HistoryListInput): string {
  const days = input.days ?? HISTORY_DEFAULT_LIST_DAYS;
  const withSubagents = input.withSubagents === true;
  const includeArchived = input.includeArchived === true;
  const workspace = input.workspace?.toLowerCase();
  return [
    `最近 ${days} 天`,
    workspace ? `标题/目录含「${input.workspace}」` : undefined,
    withSubagents ? "含子代理会话" : "已隐藏子代理会话",
    includeArchived
      ? "含已归档会话"
      : "已排除已归档会话（如需包含请传 includeArchived=true）",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * HistoryList 的结构化范围事实（用户口径）。
 *
 * 与 buildHistoryListScopeNote 同源同参，但只给事实、不带句子——UI 用 i18n 词条把
 * 这些事实拼成用户能读懂的范围说明，不把「如需包含请传 includeArchived=true」这类
 * 写给模型的行动指引暴露到界面上。
 */
export function buildHistoryListScopeFacts(input: HistoryListInput): HistoryListScopeFacts {
  return {
    days: input.days ?? HISTORY_DEFAULT_LIST_DAYS,
    withSubagents: input.withSubagents === true,
    includeArchived: input.includeArchived === true,
    ...(input.workspace ? { workspace: input.workspace } : {}),
  };
}

export async function runHistoryListQuery(
  store: HistoryStoreReads,
  input: HistoryListInput,
  options: { signal?: AbortSignal } = {},
): Promise<HistoryListOutput> {
  const days = input.days ?? HISTORY_DEFAULT_LIST_DAYS;
  const limit = input.limit ?? DEFAULT_LIST_LIMIT;
  const offset = input.offset ?? 0;
  const withSubagents = input.withSubagents === true;
  const includeArchived = input.includeArchived === true;
  const workspace = input.workspace?.toLowerCase() ?? undefined;
  const cutoff = Date.now() - days * 86_400_000;
  const scopeNote = buildHistoryListScopeNote(input);

  throwIfHistoryQueryAborted(options.signal);
  const sessions = await store.listSessions({
    includeArchived,
    limit: HISTORY_LIST_SESSION_SCAN_CAP,
  });
  throwIfHistoryQueryAborted(options.signal);
  const filtered = sessions.filter((session) =>
    matchesListScope(session, { cutoff, workspace, withSubagents, includeArchived }),
  );
  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  const summaries = await attachMessageCounts(store, page, options.signal);
  const truncated = offset + page.length < total || total >= HISTORY_LIST_SESSION_SCAN_CAP;
  return {
    status: "success",
    scopeNote,
    sessions: summaries,
    total,
    offset,
    truncated,
  };
}

export async function runHistoryReadQuery(
  store: HistoryStoreReads,
  input: HistoryReadInput,
  options: { currentSessionId: SessionId; signal?: AbortSignal },
): Promise<HistoryReadOutput> {
  const sessionId = (input.sessionId ?? options.currentSessionId) as SessionId;
  const role = input.role ?? "both";
  const fromSegment = input.fromSegment ?? null;
  const pageRequest = {
    offset: input.offset ?? 0,
    maxChars: input.maxChars ?? HISTORY_DEFAULT_MAX_CHARS,
    fromSegment,
  };

  throwIfHistoryQueryAborted(options.signal);
  const session = await store.getSession(sessionId);
  throwIfHistoryQueryAborted(options.signal);
  if (!session) {
    return buildReadFailure({
      status: "not_found",
      sessionId,
      role,
      error: `会话不存在：${sessionId}。先用 HistoryList 查到正确的 session id。`,
    });
  }
  const messages = await store.messages({ sessionID: sessionId });
  throwIfHistoryQueryAborted(options.signal);
  const turns = buildTurns(messages, role);
  if (fromSegment !== null && (fromSegment < 1 || fromSegment > turns.length)) {
    return buildReadFailure({
      status: "failed",
      sessionId,
      role,
      error: `from_segment=${fromSegment} 超出范围：全文共 ${turns.length} 段`,
    });
  }
  const page = renderTurnsPage(turns, pageRequest);
  return {
    status: "success",
    sessionId,
    role,
    title: session.title !== "" ? session.title : null,
    totalSegments: page.totalSegments,
    totalChars: page.totalChars,
    page: {
      start: page.startOffset,
      end: page.endOffset,
      nextOffset: page.nextOffset,
      viaSegment: page.viaSegment,
    },
    content: page.content,
  };
}

export async function runHistorySearchQuery(
  store: HistoryStoreReads,
  input: HistorySearchInput,
  options: { signal?: AbortSignal } = {},
): Promise<HistorySearchOutput> {
  const keywords = parseHistoryKeywords(input.query);
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  const offset = input.offset ?? 0;
  const withSubagents = input.withSubagents === true;

  const candidates = await resolveSearchCandidates(store, input, {
    withSubagents,
    includeArchived: input.includeArchived === true,
    signal: options.signal,
  });
  if (candidates === undefined) {
    return {
      status: "not_found",
      query: input.query,
      scopeNote: "",
      hits: [],
      total: 0,
      offset: 0,
      truncated: false,
      error: `会话不存在：${input.sessionId}（先用 HistoryList 查到正确的 session id）`,
    };
  }
  const days = input.days ?? HISTORY_DEFAULT_SEARCH_DAYS;

  const allHits: HistorySearchHit[] = [];
  let scanned = 0;
  let spanMin = Number.POSITIVE_INFINITY;
  let spanMax = Number.NEGATIVE_INFINITY;
  for (const session of candidates) {
    throwIfHistoryQueryAborted(options.signal);
    scanned += 1;
    if (session.time.updated < spanMin) spanMin = session.time.updated;
    if (session.time.updated > spanMax) spanMax = session.time.updated;
    const messages = await store.messages({ sessionID: session.id as SessionId });
    const turns = buildTurns(messages, "both");
    for (const [index, turn] of turns.entries()) {
      if (input.role && turn.role !== input.role) continue;
      const lower = turn.text.toLowerCase();
      if (!keywords.every((keyword) => lower.includes(keyword))) continue;
      allHits.push({
        sessionId: session.id,
        title: session.title !== "" ? session.title : null,
        segment: index + 1,
        role: turn.role,
        at: turn.at,
        snippet: makeSnippet(turn.text, keywords),
      });
    }
  }

  const scopeNote = input.sessionId
    ? `限定会话 ${input.sessionId}`
    : describeScanScope({
        candidates: candidates.length,
        span: scanned > 0 ? { min: spanMin, max: spanMax } : undefined,
        days,
        withSubagents,
        includeArchived: input.includeArchived === true,
      });

  const total = allHits.length;
  const page = allHits.slice(offset, offset + limit);
  return {
    status: "success",
    query: input.query,
    scopeNote,
    hits: page,
    total,
    offset,
    truncated: offset + page.length < total,
  };
}

export async function runIsolatedHistoryQuery(
  store: HistoryStoreReads,
  job: IsolatedHistoryJob,
  options: { signal?: AbortSignal } = {},
): Promise<IsolatedHistoryJobResult> {
  throwIfHistoryQueryAborted(options.signal);
  if (job.kind === "list") {
    return {
      kind: "list",
      output: await runHistoryListQuery(store, job.input, options),
    };
  }
  if (job.kind === "read") {
    return {
      kind: "read",
      output: await runHistoryReadQuery(store, job.input, {
        currentSessionId: job.currentSessionId,
        signal: options.signal,
      }),
    };
  }
  return {
    kind: "search",
    output: await runHistorySearchQuery(store, job.input, options),
  };
}

function matchesListScope(
  session: SessionInfo,
  scope: { cutoff: number; workspace: string | undefined; withSubagents: boolean; includeArchived: boolean },
): boolean {
  if (session.time.updated < scope.cutoff) return false;
  if (!scope.includeArchived && session.time.archived !== undefined) return false;
  if (isHiddenHistorySession(session, scope.withSubagents)) return false;
  if (scope.workspace) {
    const haystack = `${session.title ?? ""} ${session.directory}`.toLowerCase();
    if (!haystack.includes(scope.workspace)) return false;
  }
  return true;
}

async function attachMessageCounts(
  store: HistoryStoreReads,
  page: SessionInfo[],
  signal?: AbortSignal,
): Promise<HistorySessionSummary[]> {
  let counts: Record<string, number> | undefined;
  if (store.sessionMessageCounts && page.length > 0) {
    throwIfHistoryQueryAborted(signal);
    try {
      counts = await store.sessionMessageCounts({ sessionIDs: page.map((session) => session.id) });
    } catch {
      counts = undefined;
    }
  }
  return page.map((session) => {
    const summary: HistorySessionSummary = {
      sessionId: session.id,
      title: session.title !== "" ? session.title : null,
      directory: session.directory,
      timeCreated: session.time.created,
      timeUpdated: session.time.updated,
    };
    if (counts) summary.messageCount = counts[session.id] ?? 0;
    return summary;
  });
}

/** undefined = 指定的 session 不存在（调用方据此返回 not_found）。 */
async function resolveSearchCandidates(
  store: HistoryStoreReads,
  parsed: HistorySearchInput,
  scope: { withSubagents: boolean; includeArchived: boolean; signal?: AbortSignal },
): Promise<SessionInfo[] | undefined> {
  throwIfHistoryQueryAborted(scope.signal);
  if (parsed.sessionId) {
    const one = await store.getSession(parsed.sessionId as SessionId);
    if (!one) return undefined;
    return [one];
  }
  const days = parsed.days ?? HISTORY_DEFAULT_SEARCH_DAYS;
  const cutoff = Date.now() - days * 86_400_000;
  const sessions = await store.listSessions({ includeArchived: scope.includeArchived });
  throwIfHistoryQueryAborted(scope.signal);
  return sessions.filter((session) => {
    if (session.time.updated < cutoff) return false;
    if (!scope.includeArchived && session.time.archived !== undefined) return false;
    if (isHiddenHistorySession(session, scope.withSubagents)) return false;
    return true;
  });
}

function describeScanScope(input: {
  candidates: number;
  span: { min: number; max: number } | undefined;
  days: number;
  withSubagents: boolean;
  includeArchived: boolean;
}): string {
  const suffix = input.withSubagents ? "（含子代理）" : "";
  const archivedSuffix = input.includeArchived
    ? " · 含已归档会话"
    : " · 已排除已归档会话（如需包含请传 includeArchived=true）";
  if (!input.span) {
    return `最近 ${input.days} 天 · ${input.candidates} 个会话${suffix}${archivedSuffix}`;
  }
  return `${input.candidates} 个会话 · 更新于 ${formatDaySpan(input.span.min, input.span.max)}${suffix}${archivedSuffix}`;
}

function formatDaySpan(min: number, max: number): string {
  const nowYear = new Date().getFullYear();
  const withYear =
    new Date(min).getFullYear() !== nowYear || new Date(max).getFullYear() !== nowYear;
  const format = (ms: number) => {
    const date = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return withYear ? `${date.getFullYear()}-${monthDay}` : monthDay;
  };
  const from = format(min);
  const to = format(max);
  return from === to ? from : `${from} ~ ${to}`;
}

function buildReadFailure(input: {
  status: HistoryReadOutput["status"];
  sessionId: string;
  role: HistoryReadOutput["role"];
  error: string;
}): HistoryReadOutput {
  return {
    status: input.status,
    sessionId: input.sessionId,
    role: input.role,
    title: null,
    totalSegments: 0,
    totalChars: 0,
    page: { start: 0, end: 0, nextOffset: null, viaSegment: null },
    content: "",
    error: input.error,
  };
}
