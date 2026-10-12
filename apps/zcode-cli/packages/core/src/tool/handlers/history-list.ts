// ============================================================
// HistoryList Tool Handler
// ============================================================
// 会话发现面：read/search 都需要 session id，模型手里往往只有
// 「上次那个会话」这种描述，给一个轻量清单兜住这一步。SQLite 宿主走只读旁路；
// 假 store 只碰 listSessions 与可选的 sessionMessageCounts，不含消息正文。
// 行为与用户级 history MCP server 的 list 工具逐项对齐（见 docs/specs/session-history-tools.md）。

import {
  CoreErrorType,
  HISTORY_LIST_TOOL_NAME,
  HISTORY_MAX_LIST_LIMIT,
  HistoryListInputJsonSchema,
  HistoryListInputSchema,
  HistoryListOutputJsonSchema,
  HistoryListOutputSchema,
  buildHistoryListScopeNote,
  createCoreError,
  runHistoryListQuery,
  type HistoryListOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import {
  HISTORY_TOOL_MAX_OUTPUT_BYTES,
  HISTORY_TOOL_TIMEOUT_MS,
  historyErrorToMessage,
  historyToolPermission,
} from "./history-shared.js";

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

  const scopeNote = buildHistoryListScopeNote(parsed);

  try {
    if (context.sessionStore.runIsolatedHistoryJob) {
      const result = await context.sessionStore.runIsolatedHistoryJob(
        { kind: "list", input: parsed },
        { signal: context.abortSignal },
      );
      if (result.kind !== "list") {
        return {
          status: "failed",
          scopeNote,
          sessions: [],
          total: 0,
          offset: 0,
          truncated: false,
          error: "HistoryList isolated job returned a mismatched result",
        } satisfies HistoryListOutput;
      }
      return result.output;
    }
    return await runHistoryListQuery(context.sessionStore, parsed, {
      signal: context.abortSignal,
    });
  } catch (error) {
    if (context.abortSignal.aborted) throw error;
    return {
      status: "failed",
      scopeNote,
      sessions: [],
      total: 0,
      offset: 0,
      truncated: false,
      error: historyErrorToMessage(error),
    } satisfies HistoryListOutput;
  }
};

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
      "Archived sessions are excluded by default; set includeArchived=true only when the user explicitly asks to include them.",
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
  if (result.total === 0) {
    return `没有符合条件的会话（${result.scopeNote}）。试试加大 days。`;
  }
  if (result.sessions.length === 0) {
    // 修复依据：offset 只在过滤后分页，越界时给明确范围而不是空文案。
    return `offset 超出范围：共 ${result.total} 个会话，请用更小的 offset（当前 offset=${result.offset}）。`;
  }
  const lines = result.sessions.map((session) => {
    const title = session.title ?? "(无标题)";
    const count = session.messageCount === undefined ? "" : ` ${String(session.messageCount).padStart(4)} 条消息`;
    return `${formatHistoryListTime(session.timeUpdated)}${count}  ${session.sessionId}\n    ${title}${session.directory ? `\n    ${session.directory}` : ""}`;
  });
  if (!result.truncated) {
    return `${result.scopeNote} · 共 ${result.total} 个会话\n\n${lines.join("\n")}`;
  }
  const end = result.offset + result.sessions.length;
  return (
    `${result.scopeNote} · 第 ${result.offset + 1}-${end} 个 · 共 ${result.total} 个会话` +
    `（还有更多，传 offset=${end} 或加大 limit（最大 ${HISTORY_MAX_LIST_LIMIT}）续查）\n\n${lines.join("\n")}`
  );
}

function formatHistoryListTime(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
