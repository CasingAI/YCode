import {
  constants as osConstants,
  getPriority as getOsPriority,
  setPriority as setOsPriority,
} from "node:os";

export type ProcessPriority = "below-normal" | "idle";

export type ProcessPriorityResult = "applied" | "unchanged" | "skipped" | "failed";

export interface LowerProcessPriorityOptions {
  platform?: NodeJS.Platform;
  getPriority?: (pid: number) => number;
  setPriority?: (pid: number, priority: number) => void;
}

const TARGET_PRIORITY: Record<ProcessPriority, number> = {
  "below-normal": osConstants.priority.PRIORITY_BELOW_NORMAL,
  idle: osConstants.priority.PRIORITY_LOW,
};

/**
 * 尽力降低 Windows 进程的 CPU 调度优先级。
 *
 * 只接受正整数 PID，避免把 `undefined`/`0` 交给 OS 后命中当前进程；只在目标值更低时
 * 同步写入一次。读取失败时不做猜测性写入，任何错误都转化为 `failed`，由调用方忽略。
 * 非 Windows 直接跳过。本函数不是进程优先级的所有者，也不维护状态。
 */
export function lowerProcessPriority(
  pid: number | null | undefined,
  priority: ProcessPriority,
  options: LowerProcessPriorityOptions = {},
): ProcessPriorityResult {
  if ((options.platform ?? process.platform) !== "win32") return "skipped";
  if (!isValidPid(pid)) return "skipped";

  const target = TARGET_PRIORITY[priority];
  const getPriority = options.getPriority ?? getOsPriority;
  const setPriority = options.setPriority ?? setOsPriority;

  let current: number;
  try {
    current = getPriority(pid);
  } catch {
    return "failed";
  }
  if (!Number.isFinite(current)) return "failed";

  // Windows 上数值越大优先级越低。已经不低于目标值时保持现状，绝不提高已有优先级。
  if (current >= target) return "unchanged";

  try {
    setPriority(pid, target);
    return "applied";
  } catch {
    return "failed";
  }
}

function isValidPid(pid: number | null | undefined): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}
