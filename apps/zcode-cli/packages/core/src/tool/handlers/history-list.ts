// ============================================================
// HistoryList Tool Handler
// ============================================================
// 会话发现面：read/search 都需要 session id，模型手里往往只有
// 「上次那个会话」这种描述，给一个轻量清单兜住这一步。只碰 listSessions
// 与可选的 sessionMessageCounts，不含消息正文。
// 行为与用户级 history MCP server 的 list 工具逐项对齐（见 docs/specs/session-history-tools.md）。

import {
  CoreErrorType,
  HISTORY_DEFAULT_LIST_DAYS,
  HISTORY_LIST_SESSION_SCAN_CAP,
  HISTORY_LIST_TOOL_NAME,
  HistoryListInputJsonSchema,
  HistoryListInputSchema,
  HistoryListOutputJsonSchema,
  HistoryListOutputSchema,
  createCoreError,
  type HistoryListOutput,
  type HistorySessionSummary,
  type SessionInfo,
  type SessionStorePort,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { SUBAGENT_SESSION_ID_PREFIX } from "../../session-history/session-history.js";
import {
  HISTORY_TOOL_MAX_OUTPUT_BYTES,
  HISTORY_TOOL_TIMEOUT_MS,
  historyErrorToMessage,
  historyToolPermission,
} from "./history-shared.js";

const DEFAULT_LIST_LIMIT = 20;

const listHistoryHandler: ToolHandler = async (input, context) => {
  const parsed = HistoryListInputSchema.parse(input);

  if (!context.sessionStore) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SessionStorePort is not configured for HistoryList",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: HISTORY_LIST_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const days = parsed.days ?? HISTORY_DEFAULT_LIST_DAYS;
  const limit = parsed.limit ?? DEFAULT_LIST_LIMIT;
  const withSubagents = parsed.withSubagents === true;
  const workspace = parsed.workspace?.toLowerCase() ?? null;
  const cutoff = Date.now() - days * 86_400_000;
  const scopeNote = [
    `最近 ${days} 天`,
    workspace ? `标题/目录含「${parsed.workspace}」` : null,
    withSubagents ? "含子代理会话" : "已隐藏子代理会话",
  ]
    .filter(Boolean)
    .join(" · ");

  try {
    // 排序由 SQL（time_updated desc）保证；这里取最近一批再按时间窗/前缀/子串过滤。
    // 「最近 SCAN_CAP 条 ∩ 时间窗」与 MCP server「时间窗内取最近 SCAN_CAP 条」结果集等价。
    const sessions = await context.sessionStore.listSessions({
      includeArchived: true,
      limit: HISTORY_LIST_SESSION_SCAN_CAP,
    });
    const filtered = sessions.filter((session) => matchesListScope(session, { cutoff, workspace, withSubagents }));
    const page = filtered.slice(0, limit);
    const summaries = await attachMessageCounts(context.sessionStore, page);
    const output: HistoryListOutput = {
      status: "success",
      scopeNote,
      sessions: summaries,
    };
    return output;
  } catch (error) {
    if (context.abortSignal.aborted) throw error;
    return {
      status: "failed",
      scopeNote,
      sessions: [],
      error: historyErrorToMessage(error),
    } satisfies HistoryListOutput;
  }
};

function matchesListScope(
  session: SessionInfo,
  scope: { cutoff: number; workspace: string | null; withSubagents: boolean },
): boolean {
  if (session.time.updated < scope.cutoff) return false;
  if (!scope.withSubagents && session.id.startsWith(SUBAGENT_SESSION_ID_PREFIX)) return false;
  if (scope.workspace) {
    const haystack = `${session.title ?? ""} ${session.directory}`.toLowerCase();
    if (!haystack.includes(scope.workspace)) return false;
  }
  return true;
}

// 消息数是展示列：端口缺席或查询失败都降级为省略该列，不让清单整体失败。
async function attachMessageCounts(
  store: SessionStorePort,
  page: SessionInfo[],
): Promise<HistorySessionSummary[]> {
  let counts: Record<string, number> | null = null;
  if (store.sessionMessageCounts && page.length > 0) {
    try {
      counts = await store.sessionMessageCounts({ sessionIDs: page.map((session) => session.id) });
    } catch {
      counts = null;
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

export const historyListToolEntry: ToolEntry = {
  capability:
    "List recent persisted Y Code sessions (id, title, directory, message count, time) without modifying state",
  metadata: {
    name: HISTORY_LIST_TOOL_NAME,
    description:
      "List recent Y Code sessions (id, title, directory, message count) to discover session ids for HistoryRead / HistorySearch. Supports time-window and title/directory keyword filters; subagent sessions are hidden by default.",
    modelInstructions: [
      "Use when the user references a prior session without an id (e.g. 'the session from last week') or before calling HistoryRead / HistorySearch.",
      "Pass the returned session id into HistoryRead or HistorySearch; do not guess session ids.",
      "Subagent sessions are hidden by default; set withSubagents=true only when asked about subagent work.",
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
  handler: listHistoryHandler,
  formatModelContent: formatListHistoryModelContent,
  inputSchema: HistoryListInputJsonSchema,
  outputSchema: HistoryListOutputJsonSchema,
  runtimeInputSchema: HistoryListInputSchema,
  runtimeOutputSchema: HistoryListOutputSchema,
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
    userVisibleMessage: "HistoryList was cancelled before the session list was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatListHistoryModelContent(output: unknown): string {
  const result = HistoryListOutputSchema.parse(output);
  if (result.status === "failed") {
    return `HistoryList 调用失败：${result.error ?? "未知错误"}`;
  }
  if (result.sessions.length === 0) {
    return `没有符合条件的会话（${result.scopeNote}）。试试加大 days。`;
  }
  const lines = result.sessions.map((session) => {
    const title = session.title ?? "(无标题)";
    const count = session.messageCount === undefined ? "" : ` ${String(session.messageCount).padStart(4)} 条消息`;
    return `${formatHistoryListTime(session.timeUpdated)}${count}  ${session.sessionId}\n    ${title}${session.directory ? `\n    ${session.directory}` : ""}`;
  });
  return `${result.scopeNote} · 命中 ${result.sessions.length} 个会话\n\n${lines.join("\n")}`;
}

function formatHistoryListTime(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
