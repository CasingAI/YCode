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
  HISTORY_SEARCH_TOOL_NAME,
  HistorySearchInputJsonSchema,
  HistorySearchInputSchema,
  HistorySearchOutputJsonSchema,
  HistorySearchOutputSchema,
  createCoreError,
  runHistorySearchQuery,
  type HistorySearchInput,
  type HistorySearchOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import {
  HISTORY_TOOL_MAX_OUTPUT_BYTES,
  HISTORY_TOOL_TIMEOUT_MS,
  historyErrorToMessage,
  historyToolPermission,
} from "./history-shared.js";

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

  try {
    if (context.sessionStore.runIsolatedHistoryJob) {
      const result = await context.sessionStore.runIsolatedHistoryJob(
        { kind: "search", input: parsed },
        { signal: context.abortSignal },
      );
      if (result.kind !== "search") {
        return {
          status: "failed",
          query: parsed.query,
          scopeNote: "",
          hits: [],
          total: 0,
          offset: 0,
          truncated: false,
          error: "HistorySearch isolated job returned a mismatched result",
        } satisfies HistorySearchOutput;
      }
      return result.output;
    }
    return await runHistorySearchQuery(context.sessionStore, parsed, {
      signal: context.abortSignal,
    });
  } catch (error) {
    if (context.abortSignal.aborted) throw error;
    return {
      status: "failed",
      query: parsed.query,
      scopeNote: "",
      hits: [],
      total: 0,
      offset: 0,
      truncated: false,
      error: historyErrorToMessage(error),
    } satisfies HistorySearchOutput;
  }
};

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
      "Prefer short keywords; widen days when nothing matches; subagent sessions are excluded unless withSubagents=true; archived sessions are excluded unless includeArchived=true.",
      "When citing a hit in your answer, write a Markdown link [source excerpt](ycode://session/open?sessionId=<sessionId>&search=<source excerpt>) with sessionId/search from the hit (never invent session ids); the link text and search are one locatable source excerpt used for jump-to-highlight, e.g. [鉴权结论已合入](ycode://session/open?sessionId=sess_abc123&search=鉴权结论已合入). Chinese text and spaces in search do not need percent-encoding, but characters that break query parsing (&, #, ?) must be percent-encoded or reworded away.",
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
    return `[${result.offset + index + 1}] ${title} ${hit.sessionId} · 段[${hit.segment}] ${hit.role} · ${formatHitTime(hit.at)}\n    ${hit.snippet}`;
  });
  // 与 HistoryList 同一版式：分页时给“第 X-Y 个 · 共 N 个（还有更多，传 offset=…续查）”。
  const head =
    result.truncated && result.total > 0
      ? `检索「${result.query}」· 第 ${result.offset + 1}-${result.offset + result.hits.length} 个 · 共 ${result.total} 个命中 · 扫描 ${result.scopeNote}（还有更多，传 offset=${result.offset + result.hits.length} 续查）`
      : `检索「${result.query}」· 命中 ${result.total} 处 · 扫描 ${result.scopeNote}`;
  const hint = `需要更多上下文：HistoryRead(session="会话id", role="both", fromSegment=段号) 直接落到该段。`;
  return `${head}\n\n${lines.join("\n\n")}\n\n${hint}`;
}

function formatHitTime(ms: number | null): string {
  if (ms === null) return "-";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
