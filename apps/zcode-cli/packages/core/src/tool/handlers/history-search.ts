// ============================================================
// HistorySearch Tool Handler
// ============================================================
// 跨会话按关键词检索存档正文（含上下文压缩之前的全部原文）。返回命中片段和
// 坐标（session id + 段号），多数情况片段即够用；需要更多上下文时用
// HistoryRead(role="both", fromSegment=段号) 直接落到原文。
// 段号坐标与 HistoryRead(role="both") 完全一致——同一 buildTurns("both")
// 过滤 + 排序 + 拼装，见 docs/specs/session-history-tools.md。

import {
  CoreErrorType,
  HISTORY_DEFAULT_SEARCH_DAYS,
  HISTORY_SEARCH_SESSION_SCAN_CAP,
  HISTORY_SEARCH_TOOL_NAME,
  HistorySearchInputJsonSchema,
  HistorySearchInputSchema,
  HistorySearchOutputJsonSchema,
  HistorySearchOutputSchema,
  createCoreError,
  type HistorySearchHit,
  type HistorySearchInput,
  type HistorySearchOutput,
  type SessionId,
  type SessionInfo,
  type SessionStorePort,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import {
  buildTurns,
  isHiddenHistorySession,
  makeSnippet,
  parseHistoryKeywords,
} from "../../session-history/session-history.js";
import {
  HISTORY_TOOL_MAX_OUTPUT_BYTES,
  HISTORY_TOOL_TIMEOUT_MS,
  historyErrorToMessage,
  historyToolPermission,
} from "./history-shared.js";

const DEFAULT_SEARCH_LIMIT = 20;

const searchHistoryHandler: ToolHandler = async (input, context) => {
  const parsed = HistorySearchInputSchema.parse(input) as HistorySearchInput;

  if (!context.sessionStore) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SessionStorePort is not configured for HistorySearch",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: HISTORY_SEARCH_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const keywords = parseHistoryKeywords(parsed.query);
  const limit = parsed.limit ?? DEFAULT_SEARCH_LIMIT;
  const withSubagents = parsed.withSubagents === true;

  try {
    const candidates = await resolveCandidates(context.sessionStore, parsed, { withSubagents });
    if (candidates === null) {
      return {
        status: "not_found",
        query: parsed.query,
        scopeNote: "",
        hits: [],
        truncated: false,
        error: `会话不存在：${parsed.sessionId}（先用 HistoryList 查到正确的 session id）`,
      } satisfies HistorySearchOutput;
    }
    const days = parsed.days ?? HISTORY_DEFAULT_SEARCH_DAYS;

    const hits: HistorySearchHit[] = [];
    // scopeNote 只能宣称「实际扫描」的范围：时间窗（days）只是候选集过滤条件，且命中
    // 上限提前 break 后排在其后的候选连正文都没读；此前固定写「最近 N 天的 X 个会话」
    // 把过滤窗口说成了已扫描范围，模型与用户都无法据此判断真实覆盖。这里逐会话记录
    // 实际读取正文的数量与 time.updated 跨度，空候选（无跨度可报）时才回退报告时间窗。
    let scanned = 0;
    let spanMin = Number.POSITIVE_INFINITY;
    let spanMax = Number.NEGATIVE_INFINITY;
    for (const session of candidates) {
      if (hits.length >= limit) break;
      scanned += 1;
      if (session.time.updated < spanMin) spanMin = session.time.updated;
      if (session.time.updated > spanMax) spanMax = session.time.updated;
      const messages = await context.sessionStore.messages({ sessionID: session.id as SessionId });
      // 段号按 role=both 口径编号（与 HistoryRead 的坐标系一致），role 过滤只影响命中、
      // 不影响编号——这正是 search 命中的「段 N」能被 read(fromSegment=N) 精确落地的原因。
      const turns = buildTurns(messages, "both");
      for (const [index, turn] of turns.entries()) {
        if (parsed.role && turn.role !== parsed.role) continue;
        const lower = turn.text.toLowerCase();
        if (!keywords.every((keyword) => lower.includes(keyword))) continue;
        hits.push({
          sessionId: session.id,
          title: session.title !== "" ? session.title : null,
          segment: index + 1,
          role: turn.role,
          at: turn.at,
          snippet: makeSnippet(turn.text, keywords),
        });
        if (hits.length >= limit) break;
      }
    }

    const scopeNote = parsed.sessionId
      ? `限定会话 ${parsed.sessionId}`
      : describeScanScope({
          candidates: candidates.length,
          scanned,
          span: scanned > 0 ? { min: spanMin, max: spanMax } : null,
          days,
          withSubagents,
        });

    const output: HistorySearchOutput = {
      status: "success",
      query: parsed.query,
      scopeNote,
      hits,
      truncated: hits.length >= limit,
    };
    return output;
  } catch (error) {
    if (context.abortSignal.aborted) throw error;
    return {
      status: "failed",
      query: parsed.query,
      scopeNote: "",
      hits: [],
      truncated: false,
      error: historyErrorToMessage(error),
    } satisfies HistorySearchOutput;
  }
};

/** null = 指定的 session 不存在（调用方据此返回 not_found）。 */
async function resolveCandidates(
  store: SessionStorePort,
  parsed: HistorySearchInput,
  scope: { withSubagents: boolean },
): Promise<SessionInfo[] | null> {
  if (parsed.sessionId) {
    const one = await store.getSession(parsed.sessionId as SessionId);
    if (!one) return null;
    return [one];
  }
  const days = parsed.days ?? HISTORY_DEFAULT_SEARCH_DAYS;
  const cutoff = Date.now() - days * 86_400_000;
  const sessions = await store.listSessions({
    includeArchived: true,
    limit: HISTORY_SEARCH_SESSION_SCAN_CAP,
  });
  return sessions.filter((session) => {
    if (session.time.updated < cutoff) return false;
    // 默认隐藏子代理会话与 AI 历史搜索一次性会话（withSubagents=true 才纳入）。
    if (isHiddenHistorySession(session, scope.withSubagents)) return false;
    return true;
  });
}

export const historySearchToolEntry: ToolEntry = {
  capability:
    "Search persisted Y Code session transcripts by keywords across sessions without modifying state",
  metadata: {
    name: HISTORY_SEARCH_TOOL_NAME,
    description:
      "Search persisted Y Code session transcripts (including pre-compaction content) by keywords. Returns hit snippets with coordinates (session id + segment number); most of the time the snippet is enough, and HistoryRead(role=\"both\", fromSegment=segment) lands directly on the source text. Space-separated keywords are AND-combined. Only searches conversation text (user/assistant turns), not tool output or chain-of-thought.",
    modelInstructions: [
      "Use when looking for prior conclusions, root causes, decisions or snippets across past sessions.",
      "Hits are segments of the cleaned transcript; call HistoryRead with role=\"both\" and fromSegment=segment for the surrounding verbatim text.",
      "Prefer short keywords; widen days when nothing matches; subagent sessions are excluded unless withSubagents=true.",
    ],
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: HISTORY_TOOL_TIMEOUT_MS,
    maxOutputBytes: HISTORY_TOOL_MAX_OUTPUT_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: searchHistoryHandler,
  formatModelContent: formatSearchHistoryModelContent,
  inputSchema: HistorySearchInputJsonSchema,
  outputSchema: HistorySearchOutputJsonSchema,
  runtimeInputSchema: HistorySearchInputSchema,
  runtimeOutputSchema: HistorySearchOutputSchema,
  permission: historyToolPermission(),
  resultBudget: {
    maxInlineBytes: HISTORY_TOOL_MAX_OUTPUT_BYTES,
    maxModelBytes: HISTORY_TOOL_MAX_OUTPUT_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: HISTORY_TOOL_MAX_OUTPUT_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: HISTORY_TOOL_TIMEOUT_MS,
    maxMs: HISTORY_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "HistorySearch was cancelled before the hits were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatSearchHistoryModelContent(output: unknown): string {
  const result = HistorySearchOutputSchema.parse(output);
  if (result.status === "failed") {
    return `HistorySearch 调用失败：${result.error ?? "未知错误"}`;
  }
  if (result.status === "not_found") {
    return result.error ?? `会话不存在。先用 HistoryList 查到正确的 session id。`;
  }
  if (result.hits.length === 0) {
    return (
      `未命中。检索范围：${result.scopeNote}。` +
      `建议：换更短的关键词；加大 days；去掉 session 限定；注意本工具只搜对话正文（user/assistant 的话），不含工具输出与思维链。`
    );
  }
  const lines = result.hits.map((hit, index) => {
    const title = hit.title ? `《${hit.title}》` : "(无标题)";
    return `[${index + 1}] ${title} ${hit.sessionId} · 段[${hit.segment}] ${hit.role} · ${formatHitTime(hit.at)}\n    ${hit.snippet}`;
  });
  const truncatedNote = result.truncated ? `（已达上限，可能未尽）` : "";
  const hint = `需要更多上下文：HistoryRead(session="会话id", role="both", fromSegment=段号) 直接落到该段。`;
  return `检索「${result.query}」· 命中 ${result.hits.length} 处 · 扫描 ${result.scopeNote}${truncatedNote}\n\n${lines.join("\n\n")}\n\n${hint}`;
}

/** 跨会话 scopeNote：报告实际扫描的会话数与已扫会话的更新时间跨度；span=null 表示没有读到任何候选，回退报告时间窗。 */
function describeScanScope(input: {
  candidates: number;
  scanned: number;
  span: { min: number; max: number } | null;
  days: number;
  withSubagents: boolean;
}): string {
  const suffix = input.withSubagents ? "（含子代理）" : "";
  if (input.span === null) {
    return `最近 ${input.days} 天 · ${input.candidates} 个会话${suffix}`;
  }
  const count =
    input.scanned < input.candidates
      ? `${input.scanned}/${input.candidates} 个会话`
      : `${input.candidates} 个会话`;
  return `${count} · 更新于 ${formatDaySpan(input.span.min, input.span.max)}${suffix}`;
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

function formatHitTime(ms: number | null): string {
  if (ms === null) return "-";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
