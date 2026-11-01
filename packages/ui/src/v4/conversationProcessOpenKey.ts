const TURN_PROCESS_OPEN_KEY_PREFIX = "zc-turn-process";
const FILE_ACTIVITY_OPEN_KEY_PREFIX = "zc-file-activity";

// rowId 只在单次 (sessionId, logEpoch) 物化范围内唯一；展开态 Map 属于整个
// renderer，缺少作用域会让并行 Subagent 的相同 rowId 共享历史过程行的展开态。
function buildScopedOpenKey(
  prefix: string,
  sessionId: string | null | undefined,
  logEpoch: string | null | undefined,
  key: string,
): string {
  const scopedSessionId = sessionId?.trim() ?? "";
  const scopedLogEpoch = logEpoch?.trim() ?? "";
  return `${prefix}:${scopedSessionId}:${scopedLogEpoch}:${key}`;
}

export function buildProcessPersistOpenKey(
  sessionId: string | null | undefined,
  logEpoch: string | null | undefined,
  processKey: string,
): string {
  return buildScopedOpenKey(TURN_PROCESS_OPEN_KEY_PREFIX, sessionId, logEpoch, processKey);
}

/** 文件活动行与过程行共用同一张展开态表，但用独立前缀避免两层的键相撞。 */
export function buildFileActivityPersistOpenKey(
  sessionId: string | null | undefined,
  logEpoch: string | null | undefined,
  fileActivityKey: string,
): string {
  return buildScopedOpenKey(
    FILE_ACTIVITY_OPEN_KEY_PREFIX,
    sessionId,
    logEpoch,
    fileActivityKey,
  );
}
