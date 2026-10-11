import type {
  ToolCallHistoryReadDisplay,
  ToolCallHistorySearchDisplay,
} from "@zcode/shared/zcode-protocol-v4";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import type { ConversationStoreState } from "@/v4/conversationProjectionStore.js";

// 会话引用白名单：历史工具在当前回合带出过的会话 id 集合
// （docs/specs/assistant-session-citation.md「引用校验」）。
//
// 增量维护、禁止按消息扫描：只在新的 toolCall 行进入投影时取数，元素数与工具
// 调用数相关、与会话轮数无关；行被窗口淘汰不移除（旧引用仍可校验）。
// 校验只在消息真含引用指令时触发，无引用消息零成本。
//
// 数据来源只有两处（与 HistoryList 无 sessionId 无关）：
// - HistorySearch 成功行的 display.citations[].sessionId（主来源）。
// - HistoryRead 成功行的 display.sessionId（模型显式读过的单会话）。
export type HistoryToolSeenSessionIds = ReadonlySet<string>;

const HISTORY_TOOL_NAMES = new Set([
  "HistorySearch",
  "HistoryRead",
  "history_search",
  "history_read",
]);

function collectSeenSessionIdsFromRows(rows: readonly unknown[], into: Set<string>): void {
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (record.kind !== "toolCall") continue;
    const toolName = record.toolName;
    if (typeof toolName !== "string" || !HISTORY_TOOL_NAMES.has(toolName)) continue;
    if (record.status !== "success") continue;
    const output = record.output;
    if (!output || typeof output !== "object") continue;
    // toolCall 行的 display 藏法不止一处：与 readCitations 同口径，
    // 先读 row.output.display，再退回 readToolResultDisplay 的多位置解析。
    const rawDisplay =
      (output as Record<string, unknown>).display ?? readToolResultDisplay(output as never);
    if (!rawDisplay || typeof rawDisplay !== "object") continue;
    const display = rawDisplay as Record<string, unknown>;
    if (display.kind === "history_search") {
      const parsed = display as unknown as ToolCallHistorySearchDisplay;
      if (!Array.isArray(parsed.citations)) continue;
      for (const citation of parsed.citations) {
        const sessionId = citation?.sessionId?.trim();
        if (sessionId) into.add(sessionId);
      }
      continue;
    }
    if (display.kind === "history_read") {
      const parsed = display as unknown as ToolCallHistoryReadDisplay;
      const sessionId = parsed.sessionId?.trim();
      if (sessionId) into.add(sessionId);
    }
  }
}

/**
 * 从投影快照构建初始集合：冷加载 / 懒建时对已加载的窗口做一次重建。
 * 规模只与已加载工具行数有关，不遍历消息文本。
 */
export function buildHistoryToolSeenSessionIds(
  state: ConversationStoreState | null | undefined,
): Set<string> {
  const seen = new Set<string>();
  const rows = state?.snapshot?.rows?.window;
  if (Array.isArray(rows)) collectSeenSessionIdsFromRows(rows, seen);
  return seen;
}

/**
 * 增量补充：新进入投影的 toolCall 行进来时调用。调用方负责"只传新行"——
 * 例如按 revision 差量或在新行追加时顺手调用，不要每次传全窗口。
 */
export function addHistoryToolSeenSessionIds(target: Set<string>, rows: readonly unknown[]): void {
  collectSeenSessionIdsFromRows(rows, target);
}

/** O(1) 成员判断：引用 session 是否被历史工具带出过。 */
export function isHistoryToolSeenSession(
  seen: HistoryToolSeenSessionIds | null | undefined,
  sessionId: string,
): boolean {
  if (!seen) return false;
  return seen.has(sessionId.trim());
}
