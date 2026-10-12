// ============================================================
// Session History - 会话存档只读投影的 core 再导出
// ============================================================
// 唯一实现已迁到 @zcode/contracts（adapters 旁路工作线程不能依赖 core）。
// 详见 docs/specs/session-history-tools.md。

export {
  AI_HISTORY_SEARCH_SESSION_ID_PREFIX,
  AI_HISTORY_SEARCH_SESSION_TASK_TYPE,
  SUBAGENT_SESSION_ID_PREFIX,
  buildTurns,
  formatHistoryTime,
  formatReadPageHead,
  isHiddenHistorySession,
  makeSnippet,
  parseHistoryKeywords,
  renderTurnsPage,
  wantMessage,
  type HistoryTranscriptPage,
  type HistoryTurn,
} from "@zcode/contracts";
