/**
 * 会话存档三工具（HistoryList / HistoryRead / HistorySearch）的结果卡 display 构造。
 *
 * 与 workflow-observation-display.ts 同一骨架：safeParse 输出 schema → display 侧独立限长
 * → 超限打 truncated。载荷刻意只喂折叠行摘要（计数 / query / 标题 / 段坐标）；展开态渲染
 * wire 上已有的 output.text（formatModelContent 投影），不在这里搬正文。字段表与降级语义
 * 见 docs/specs/session-history-tools.md「聊天工具卡」。
 */

import {
  HISTORY_DISPLAY_MAX_QUERY_CHARS,
  HISTORY_DISPLAY_MAX_SCOPE_NOTE_CHARS,
  HISTORY_DISPLAY_MAX_TITLE_CHARS,
  HISTORY_LIST_TOOL_NAME,
  HISTORY_READ_TOOL_NAME,
  HISTORY_SEARCH_TOOL_NAME,
  HistoryListOutputSchema,
  HistoryReadOutputSchema,
  HistorySearchOutputSchema,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";

import { boundDisplayText } from "./display-text.js";

export function createHistoryDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  switch (toolName) {
    case HISTORY_LIST_TOOL_NAME:
      return createHistoryListDisplay(output);
    case HISTORY_READ_TOOL_NAME:
      return createHistoryReadDisplay(output);
    case HISTORY_SEARCH_TOOL_NAME:
      return createHistorySearchDisplay(output);
    default:
      return undefined;
  }
}

function createHistoryListDisplay(output: unknown): ToolResultDisplayPayload | undefined {
  const parsed = HistoryListOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  const data = parsed.data;

  const boundScope = boundOptionalText(data.scopeNote, HISTORY_DISPLAY_MAX_SCOPE_NOTE_CHARS);
  return {
    kind: "history_list",
    status: data.status,
    ...(boundScope === undefined ? {} : { scopeNote: boundScope.value }),
    sessionCount: data.sessions.length,
    ...(boundScope?.truncated === true ? { truncated: true } : {}),
  };
}

function createHistoryReadDisplay(output: unknown): ToolResultDisplayPayload | undefined {
  const parsed = HistoryReadOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  const data = parsed.data;

  // display schema 要求 sessionId 非空；输出侧没有这条约束，空值时放弃载荷走文本兜底。
  if (data.sessionId.trim().length === 0) return undefined;
  const boundTitle =
    data.title === null ? undefined : boundDisplayText(data.title, HISTORY_DISPLAY_MAX_TITLE_CHARS);
  // 折叠行只回答「读了哪个会话」：标题 / sessionId。段坐标与总量不进载荷——
  // 没有消费者的字段只增 wire 字节（resume_workflow_run 同一惯例）。
  return {
    kind: "history_read",
    status: data.status,
    ...(boundTitle === undefined ? {} : { title: boundTitle.value }),
    sessionId: data.sessionId,
    ...(boundTitle?.truncated === true ? { truncated: true } : {}),
  };
}

function createHistorySearchDisplay(output: unknown): ToolResultDisplayPayload | undefined {
  const parsed = HistorySearchOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  const data = parsed.data;

  // 折叠行的主体就是 query；空串（不该发生，输入 schema min(1) 兜底）走文本兜底。
  if (data.query.trim().length === 0) return undefined;
  const boundQuery = boundDisplayText(data.query, HISTORY_DISPLAY_MAX_QUERY_CHARS);
  return {
    kind: "history_search",
    status: data.status,
    query: boundQuery.value,
    hitCount: data.hits.length,
    // 输出侧 truncated（命中上限截断扫描）与 query 截断并进同一标记。
    ...(boundQuery.truncated || data.truncated === true ? { truncated: true } : {}),
  };
}

function boundOptionalText(
  value: string,
  maxBytes: number,
): { value: string; truncated: boolean } | undefined {
  if (value.trim().length === 0) return undefined;
  return boundDisplayText(value, maxBytes);
}
