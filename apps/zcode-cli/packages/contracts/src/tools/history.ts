import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

// ============================================================
// Session History Tools - HistoryList / HistoryRead / HistorySearch
// ============================================================
// 只读会话存档工具面：语义与用户级 history MCP server（mcp__history__*）对齐，
// 数据通路改为 SessionStorePort。规则与坐标系见 docs/specs/session-history-tools.md。

export const HISTORY_LIST_TOOL_NAME = "HistoryList";
export const HISTORY_READ_TOOL_NAME = "HistoryRead";
export const HISTORY_SEARCH_TOOL_NAME = "HistorySearch";

export const HISTORY_DEFAULT_MAX_CHARS = 24000;
export const HISTORY_DEFAULT_LIST_DAYS = 7;
export const HISTORY_DEFAULT_SEARCH_DAYS = 14;
export const HISTORY_MAX_LIST_LIMIT = 100;
export const HISTORY_MAX_SEARCH_LIMIT = 50;
/** 片段：以命中位置为中心各取多少字符（与 MCP server 的 ±90 一致）。 */
export const HISTORY_SNIPPET_CONTEXT_CHARS = 90;
/** handler 内部扫描上限：list 取最近 N 个会话再过滤（含归档）。 */
export const HISTORY_LIST_SESSION_SCAN_CAP = 1000;
/** handler 内部扫描上限：search 取最近 N 个会话再按时间窗过滤。 */
export const HISTORY_SEARCH_SESSION_SCAN_CAP = 200;

const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9._-]+$/;

export const HistoryReadRoleSchema = z.enum(["assistant", "user", "both"]);
export type HistoryReadRole = z.infer<typeof HistoryReadRoleSchema>;

export const HistorySearchRoleSchema = z.enum(["assistant", "user"]);
export type HistorySearchRole = z.infer<typeof HistorySearchRoleSchema>;

// -----------------------------------------------
// HistoryList
// -----------------------------------------------

export const HistoryListInputSchema = z
  .object({
    days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe(`Only look at sessions updated within the last N days. Default ${HISTORY_DEFAULT_LIST_DAYS}.`),
    limit: z
      .number()
      .int()
      .min(1)
      .max(HISTORY_MAX_LIST_LIMIT)
      .optional()
      .describe(`Maximum number of sessions to return. Default 20, cap ${HISTORY_MAX_LIST_LIMIT}.`),
    workspace: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Case-insensitive substring filter over session title and directory, e.g. Custom/YCode."),
    withSubagents: z
      .boolean()
      .optional()
      .describe("Set true to include subagent sessions (sess_subagent_*); they are hidden by default."),
  })
  .strict();

export type HistoryListInput = z.infer<typeof HistoryListInputSchema>;

export const HistorySessionSummarySchema = z
  .object({
    sessionId: z.string(),
    title: z.string().nullable(),
    directory: z.string(),
    /** 会话消息总数；宿主未提供 sessionMessageCounts 时省略。 */
    messageCount: z.number().int().nonnegative().optional(),
    timeCreated: z.number(),
    timeUpdated: z.number(),
  })
  .strict();

export type HistorySessionSummary = z.infer<typeof HistorySessionSummarySchema>;

export const HistoryListOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    scopeNote: z.string(),
    sessions: z.array(HistorySessionSummarySchema),
    error: z.string().optional(),
  })
  .strict();

export type HistoryListOutput = z.infer<typeof HistoryListOutputSchema>;

// -----------------------------------------------
// HistoryRead
// -----------------------------------------------

export const HistoryReadInputSchema = z
  .object({
    sessionId: z
      .string()
      .regex(SESSION_ID_PATTERN, "Session id must use the sess_* format.")
      .optional()
      .describe("Target Y Code session id, sess_*. Omit to read the current session."),
    role: HistoryReadRoleSchema.optional().default("both").describe(
      "both = full transcript (default); assistant = only what the AI said; user = verbatim user turns (system-injected user messages are stripped).",
    ),
    fromSegment: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Start returning from segment N (1-based; segment numbers come from HistorySearch hits). Mutually exclusive with offset and takes precedence.",
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Character offset into the full transcript for paging. Take it from the previous result's nextOffset."),
    maxChars: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        `Maximum characters to return per call. Default ${HISTORY_DEFAULT_MAX_CHARS}; 0 = unbounded (a huge session can overflow the context window; only use when the full transcript is truly needed).`,
      ),
  })
  .strict();

export type HistoryReadInput = z.infer<typeof HistoryReadInputSchema>;

export const HistoryReadPageSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    /** null 表示已到末尾（或 maxChars=0 全量）。 */
    nextOffset: z.number().int().nonnegative().nullable(),
    /** fromSegment 命中时记录实际起始段号；纯 offset 翻页为 null。 */
    viaSegment: z.number().int().min(1).nullable(),
  })
  .strict();

export type HistoryReadPage = z.infer<typeof HistoryReadPageSchema>;

export const HistoryReadOutputSchema = z
  .object({
    status: z.enum(["success", "not_found", "failed"]),
    sessionId: z.string(),
    role: HistoryReadRoleSchema,
    title: z.string().nullable(),
    /** 坐标系与 HistorySearch 命中的段号一致（role=both 口径）。 */
    totalSegments: z.number().int().nonnegative(),
    totalChars: z.number().int().nonnegative(),
    page: HistoryReadPageSchema,
    content: z.string(),
    error: z.string().optional(),
  })
  .strict();

export type HistoryReadOutput = z.infer<typeof HistoryReadOutputSchema>;

// -----------------------------------------------
// HistorySearch
// -----------------------------------------------

export const HistorySearchInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(4000)
      .describe("Keywords to search for. Space-separated keywords are AND-combined."),
    sessionId: z
      .string()
      .regex(SESSION_ID_PATTERN, "Session id must use the sess_* format.")
      .optional()
      .describe("Optional. Restrict the search to one session; omit to search across sessions."),
    days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe(`Cross-session searches only look at the last N days. Default ${HISTORY_DEFAULT_SEARCH_DAYS}.`),
    limit: z
      .number()
      .int()
      .min(1)
      .max(HISTORY_MAX_SEARCH_LIMIT)
      .optional()
      .describe(`Maximum number of hits to return. Default 20, cap ${HISTORY_MAX_SEARCH_LIMIT}.`),
    role: HistorySearchRoleSchema.optional().describe("Optional. Only search AI turns / only search verbatim user turns."),
    withSubagents: z
      .boolean()
      .optional()
      .describe("Set true to include subagent sessions (sess_subagent_*); they are excluded by default."),
  })
  .strict();

export type HistorySearchInput = z.infer<typeof HistorySearchInputSchema>;

export const HistorySearchHitSchema = z
  .object({
    sessionId: z.string(),
    title: z.string().nullable(),
    /** 落地坐标：HistoryRead(role="both", fromSegment=segment) 直接落到该段。 */
    segment: z.number().int().min(1),
    role: z.enum(["user", "assistant"]),
    at: z.number().nullable(),
    snippet: z.string(),
  })
  .strict();

export type HistorySearchHit = z.infer<typeof HistorySearchHitSchema>;

export const HistorySearchOutputSchema = z
  .object({
    status: z.enum(["success", "not_found", "failed"]),
    query: z.string(),
    scopeNote: z.string(),
    hits: z.array(HistorySearchHitSchema),
    /** 达到 limit 后停止扫描时为 true，可能未尽。 */
    truncated: z.boolean(),
    error: z.string().optional(),
  })
  .strict();

export type HistorySearchOutput = z.infer<typeof HistorySearchOutputSchema>;

export const HistoryListInputJsonSchema = toToolJsonSchema(HistoryListInputSchema);
export const HistoryListOutputJsonSchema = toToolJsonSchema(HistoryListOutputSchema);
export const HistoryReadInputJsonSchema = toToolJsonSchema(HistoryReadInputSchema);
export const HistoryReadOutputJsonSchema = toToolJsonSchema(HistoryReadOutputSchema);
export const HistorySearchInputJsonSchema = toToolJsonSchema(HistorySearchInputSchema);
export const HistorySearchOutputJsonSchema = toToolJsonSchema(HistorySearchOutputSchema);

// -----------------------------------------------
// 结果卡 display 载荷（UI 通道，不进模型上下文）
// -----------------------------------------------
// 规则见 docs/specs/session-history-tools.md「聊天工具卡」。载荷刻意只喂折叠行摘要：
// 展开态渲染 wire 上已有的 output.text（formatModelContent 投影），不在这里搬正文。
// 文本字段在构造侧（core 的 history-display.ts）用 boundDisplayText 独立限长——display
// 不过 result budget，超限就地截断并打 truncated。

export const HISTORY_DISPLAY_MAX_TITLE_CHARS = 120;
export const HISTORY_DISPLAY_MAX_QUERY_CHARS = 120;
export const HISTORY_DISPLAY_MAX_SCOPE_NOTE_CHARS = 160;

export const historyListToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("history_list"),
    status: z.enum(["success", "failed"]),
    scopeNote: z.string().max(HISTORY_DISPLAY_MAX_SCOPE_NOTE_CHARS).optional(),
    sessionCount: z.number().int().nonnegative(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type HistoryListToolResultDisplayPayload = z.infer<
  typeof historyListToolResultDisplayPayloadSchema
>;

export const historySearchToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("history_search"),
    status: z.enum(["success", "failed", "not_found"]),
    query: z.string().min(1).max(HISTORY_DISPLAY_MAX_QUERY_CHARS),
    hitCount: z.number().int().nonnegative(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type HistorySearchToolResultDisplayPayload = z.infer<
  typeof historySearchToolResultDisplayPayloadSchema
>;

export const historyReadToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("history_read"),
    status: z.enum(["success", "failed", "not_found"]),
    title: z.string().min(1).max(HISTORY_DISPLAY_MAX_TITLE_CHARS).optional(),
    sessionId: z.string().min(1),
    truncated: z.boolean().optional(),
  })
  .strict();
export type HistoryReadToolResultDisplayPayload = z.infer<
  typeof historyReadToolResultDisplayPayloadSchema
>;
