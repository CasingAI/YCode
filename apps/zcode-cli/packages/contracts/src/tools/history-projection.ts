// ============================================================
// Session History 投影 — 会话存档的只读坐标（纯函数，无 IO）
// ============================================================
// HistoryList / HistoryRead / HistorySearch 与 SQLite 只读旁路共用的唯一实现：
// 消息过滤、段号坐标、分页换算、命中片段。adapters 不能依赖 core，旁路工作线程
// 必须和 handler 共用这一套坐标，禁止第二份 buildTurns。
// 详见 docs/specs/session-history-tools.md。

import type { MessageInfo, MessageWithParts } from "../interfaces/session-store.port.js";
import { HISTORY_SNIPPET_CONTEXT_CHARS, type HistoryReadRole } from "./history.js";

/** 子代理会话 id 前缀；list/search 默认隐藏，与 MCP server 行为一致。 */
export const SUBAGENT_SESSION_ID_PREFIX = "sess_subagent_";

/**
 * 命令中心一次性 AI 历史搜索会话 id 前缀（docs/specs/command-center-ai-history-search.md）。
 * list/search 默认隐藏（与子代理会话同一 withSubagents 开关），避免一次 AI 搜索
 * 搜到搜索过程自己。
 */
export const AI_HISTORY_SEARCH_SESSION_ID_PREFIX = "sess_ai_search_";

/** AI 历史搜索一次性会话的任务类型；与上面的 id 前缀双重判定。 */
export const AI_HISTORY_SEARCH_SESSION_TASK_TYPE = "ai_history_search" as const;

/**
 * 该会话是否默认不进 HistoryList/Search（子代理会话 + AI 历史搜索一次性会话）。
 * withSubagents=true 时才纳入——两类隐藏会话共用同一开关，不另开参数。
 */
export function isHiddenHistorySession(
  session: { id: string; taskType?: string },
  withSubagents: boolean,
): boolean {
  if (withSubagents) return false;
  if (session.id.startsWith(SUBAGENT_SESSION_ID_PREFIX)) return true;
  if (session.id.startsWith(AI_HISTORY_SEARCH_SESSION_ID_PREFIX)) return true;
  if (session.taskType === AI_HISTORY_SEARCH_SESSION_TASK_TYPE) return true;
  return false;
}

export interface HistoryTurn {
  role: "user" | "assistant";
  /** 消息创建时间（unix ms）；缺失时为 null。 */
  at: number | null;
  text: string;
}

// 这条消息是不是「人说的话 / 模型说的话」。剔除三类噪声：
// 非 user/assistant 角色、timeline 事件（模型切换等）、transcriptVisibility=hidden
// （系统提醒、压缩摘要）。role=user 再要求 origin=real_user——hook 注入的上下文、
// 命令包装都是 origin=system，那不是用户讲的。
export function wantMessage(info: MessageInfo, roleWanted: HistoryReadRole): boolean {
  if (info.role !== "user" && info.role !== "assistant") return false;
  const sem = info.semantics;
  if (sem?.kind === "timeline_event") return false;
  if (sem?.transcriptVisibility === "hidden") return false;
  const wantUser = roleWanted === "user" || (roleWanted === "both" && info.role === "user");
  if (wantUser && sem?.origin !== "real_user") return false;
  return roleWanted === "both" || info.role === roleWanted;
}

// 取全会话正文。压缩不删数据，所以这里天然包含压缩前的原文——不需要任何开关。
// 同一条消息的多个 text part 按存储顺序用 "\n" 拼接（与 MCP server 的 part 聚合一致）。
export function buildTurns(
  messages: readonly MessageWithParts[],
  roleWanted: HistoryReadRole,
): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  for (const { info, parts } of messages) {
    if (!wantMessage(info, roleWanted)) continue;
    const texts = parts
      .filter((part) => part.type === "text" && part.text.trim() !== "")
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter((text) => text !== "");
    if (texts.length === 0) continue;
    turns.push({
      role: info.role,
      at: info.time?.created ?? null,
      text: texts.join("\n"),
    });
  }
  return turns;
}

// 工具调用次数是会话级事实，不随 role 过滤变化：工具 part 挂在 assistant message 上，
// role=user 时正文为空，但会话做过多少次工具调用仍然要报出来。纯工具调用会话（尤其
// 子代理会话）的正文可能极少，模型要靠这个次数判断该会话做过多少工作。
export function countToolCalls(messages: readonly MessageWithParts[]): number {
  let count = 0;
  for (const { parts } of messages) {
    for (const part of parts) {
      if (part.type === "tool") count += 1;
    }
  }
  return count;
}

export interface HistoryTranscriptPage {
  /** 段块拼装后的本页正文（含段头行）。 */
  content: string;
  totalSegments: number;
  totalChars: number;
  /** 该会话的工具调用总次数；会话级事实，不随 role 过滤变化。 */
  toolCallCount: number;
  startOffset: number;
  endOffset: number;
  /** null 表示已到末尾（或 maxChars=0 全量）。 */
  nextOffset: number | null;
  /** fromSegment 命中时记录实际起始段号；纯 offset 翻页为 null。 */
  viaSegment: number | null;
}

// 段块：`[序号] 时间 role` 头行 + 正文；段间以 "\n\n" 分隔。
// 与 MCP server 的 renderTurns 同版式，偏移换算也一致（分隔符按 2 字符计）。
function turnBlocks(turns: readonly HistoryTurn[]): string[] {
  return turns.map(
    (turn, index) => `[${index + 1}] ${formatHistoryTime(turn.at)} ${turn.role}\n${turn.text}`,
  );
}

export function renderTurnsPage(
  turns: readonly HistoryTurn[],
  page: { offset: number; maxChars: number; fromSegment: number | null },
  toolCallCount = 0,
): HistoryTranscriptPage {
  const blocks = turnBlocks(turns);
  const full = blocks.join("\n\n");
  const total = full.length;
  let startOffset = page.offset;
  let viaSegment: number | null = null;
  if (page.fromSegment != null) {
    let acc = 0;
    for (let i = 0; i < page.fromSegment - 1; i++) acc += blocks[i].length + 2;
    startOffset = acc;
    viaSegment = page.fromSegment;
  }
  const end = page.maxChars === 0 ? total : Math.min(total, startOffset + page.maxChars);
  const nextOffset = page.maxChars === 0 || end >= total ? null : end;
  const content =
    startOffset >= total ? "（offset 已超出全文长度，没有更多内容）" : full.slice(startOffset, end);
  return {
    content,
    totalSegments: turns.length,
    totalChars: total,
    toolCallCount,
    startOffset,
    endOffset: end,
    nextOffset,
    viaSegment,
  };
}

// 状态行：`正文共 N 段 / M 字符 · 工具调用 K 次（含上下文压缩之前的全部原文） · 本页：…`
export function formatReadPageHead(page: HistoryTranscriptPage): string {
  const parts = [
    `正文共 ${page.totalSegments} 段 / ${page.totalChars.toLocaleString()} 字符 · 工具调用 ${page.toolCallCount} 次（含上下文压缩之前的全部原文）`,
    `本页：字符 ${page.startOffset.toLocaleString()}–${page.endOffset.toLocaleString()}${page.viaSegment ? `（自第 ${page.viaSegment} 段起）` : ""}`,
    page.nextOffset !== null ? `未完，续读传 offset=${page.nextOffset}` : "已到末尾",
  ];
  return parts.join(" · ");
}

// 关键词解析：空白分隔、小写、去重（AND 语义）。
export function parseHistoryKeywords(query: string): string[] {
  return [...new Set(query.split(/\s+/).map((k) => k.toLowerCase()).filter(Boolean))];
}

// 片段：以命中位置为中心取 ±HISTORY_SNIPPET_CONTEXT_CHARS 字符，压平换行，
// 关键词用【】高亮。pos 直接在压平文本上重找（原始偏移在压平后会漂移，重找更稳）。
export function makeSnippet(text: string, keywords: readonly string[]): string {
  const flat = text.replace(/\s+/g, " ");
  const lowerFlat = flat.toLowerCase();
  let center = -1;
  for (const keyword of keywords) {
    const pos = lowerFlat.indexOf(keyword);
    if (pos >= 0 && (center < 0 || pos < center)) center = pos;
  }
  if (center < 0) center = 0;
  const start = Math.max(0, center - HISTORY_SNIPPET_CONTEXT_CHARS);
  const end = Math.min(flat.length, center + HISTORY_SNIPPET_CONTEXT_CHARS);
  let snippet = (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
  for (const keyword of keywords) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    snippet = snippet.replace(new RegExp(escaped, "gi"), (m) => `【${m}】`);
  }
  return snippet;
}

// 与 MCP server 同款短时间格式：`MM-DD HH:mm`；无效时间显示 "-"。
export function formatHistoryTime(ms: number | null): string {
  const date = ms ? new Date(ms) : undefined;
  if (!date || Number.isNaN(date.getTime())) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
