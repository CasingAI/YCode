import type {
  BackgroundWorkSummary,
  SessionPhase,
  V4ConversationSessionStorageResult,
} from "@zcode/shared/zcode-protocol-v4";

export const SESSION_STORAGE_WARNING_THRESHOLD_BYTES = 50 * 1024 * 1024;

export function shouldShowSessionStorageWarning(
  usage: V4ConversationSessionStorageResult | null,
): boolean {
  return Boolean(
    usage &&
    usage.complete &&
    !usage.dismissed &&
    usage.totalBytes > SESSION_STORAGE_WARNING_THRESHOLD_BYTES,
  );
}

export function isTerminalSessionPhase(phase: SessionPhase): boolean {
  return phase === "completedSuccess" || phase === "completedInterrupted" || phase === "error";
}

export function shouldScanForSessionStorageWarning(
  previousPhase: SessionPhase,
  currentPhase: SessionPhase,
  firstObservation: boolean,
): boolean {
  return (
    (firstObservation && isTerminalSessionPhase(currentPhase)) ||
    (previousPhase === "running" && isTerminalSessionPhase(currentPhase))
  );
}

/** 当前 snapshot 中由 running 转为终态或消失的后台工作。 */
export function findCompletedBackgroundWorkIds(
  previous: ReadonlyMap<string, BackgroundWorkSummary["status"]>,
  current: readonly BackgroundWorkSummary[],
): string[] {
  const currentById = new Map(current.map((work) => [work.workId, work.status]));
  const completed: string[] = [];
  for (const [workId, previousStatus] of previous) {
    if (previousStatus === "running" && currentById.get(workId) !== "running") {
      completed.push(workId);
    }
  }
  return completed;
}

export function backgroundWorkStatuses(
  works: readonly BackgroundWorkSummary[],
): Map<string, BackgroundWorkSummary["status"]> {
  return new Map(works.map((work) => [work.workId, work.status]));
}
