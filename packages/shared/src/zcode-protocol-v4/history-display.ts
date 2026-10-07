// ============================================================
// 会话存档三工具（HistoryList / HistoryRead / HistorySearch）的工具卡 display 载荷
// ============================================================
// 照 workflow-observation-display.ts 的先例单独成模块（特性级 schema 不堆进 toolDisplay.ts）。
//
// ⚠ 与 apps/zcode-cli/packages/contracts/src/tools/history.ts 的三个
// historyXxxToolResultDisplayPayloadSchema 成员必须同步——两侧都是 strict，缺一侧整条
// row/display 校验失败、工具卡退化成 kindLabel 一行（fail-closed，不报错）。
// 规则与字段表见 docs/specs/session-history-tools.md「聊天工具卡」。

import { z } from "zod";

// 与 contracts 侧 HISTORY_DISPLAY_MAX_* 一一对应。
const HISTORY_DISPLAY_MAX_TITLE_CHARS = 120;
const HISTORY_DISPLAY_MAX_QUERY_CHARS = 120;
const HISTORY_DISPLAY_MAX_SCOPE_NOTE_CHARS = 160;

export const toolCallHistoryListDisplaySchema = z
  .object({
    kind: z.literal("history_list"),
    status: z.enum(["success", "failed"]),
    scopeNote: z.string().max(HISTORY_DISPLAY_MAX_SCOPE_NOTE_CHARS).optional(),
    sessionCount: z.number().int().nonnegative(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallHistoryListDisplay = z.infer<typeof toolCallHistoryListDisplaySchema>;

export const toolCallHistorySearchDisplaySchema = z
  .object({
    kind: z.literal("history_search"),
    status: z.enum(["success", "failed", "not_found"]),
    query: z.string().min(1).max(HISTORY_DISPLAY_MAX_QUERY_CHARS),
    hitCount: z.number().int().nonnegative(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallHistorySearchDisplay = z.infer<typeof toolCallHistorySearchDisplaySchema>;

export const toolCallHistoryReadDisplaySchema = z
  .object({
    kind: z.literal("history_read"),
    status: z.enum(["success", "failed", "not_found"]),
    title: z.string().min(1).max(HISTORY_DISPLAY_MAX_TITLE_CHARS).optional(),
    sessionId: z.string().min(1),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallHistoryReadDisplay = z.infer<typeof toolCallHistoryReadDisplaySchema>;
