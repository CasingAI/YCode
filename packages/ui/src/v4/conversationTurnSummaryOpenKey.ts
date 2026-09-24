const TURN_SUMMARY_OPEN_KEY_PREFIX = "zc-turn-summary";

// rowId 只在单次 (sessionId, logEpoch) 物化范围内唯一；展开态 Map 属于整个
// renderer，缺少作用域会让并行 Subagent 的相同 rowId 共享历史摘要的展开态。
export function buildTurnSummaryPersistOpenKey(
  sessionId: string | null | undefined,
  logEpoch: string | null | undefined,
  summaryKey: string,
): string {
  const scopedSessionId = sessionId?.trim() ?? "";
  const scopedLogEpoch = logEpoch?.trim() ?? "";
  return `${TURN_SUMMARY_OPEN_KEY_PREFIX}:${scopedSessionId}:${scopedLogEpoch}:${summaryKey}`;
}
