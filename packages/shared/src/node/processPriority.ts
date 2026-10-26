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

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["win32", "darwin", "linux"]);

/**
 * 尽力降低 Windows、macOS 和 Linux 进程的 CPU 调度优先级。
 *
 * 目标值沿用 Node `os.constants.priority`：`below-normal` = 10，`idle` = 19。
 * Windows 分别对应 BELOW_NORMAL_PRIORITY_CLASS / IDLE_PRIORITY_CLASS；macOS 和 Linux
 * 写入绝对 nice 10/19。Unix 的 `idle` 是 Node 可设置的最低 nice 值，不是 Linux
 * `SCHED_IDLE` 调度策略，也不设置 macOS QoS class；已继承的 macOS nice 20 保持不变。
 *
 * 只接受正整数 PID，避免把 `undefined`/`0` 交给 OS 后命中当前进程；只在当前调度值
 * 不低于目标值时保持现状，绝不提高已有优先级（包括已继承的 nice 10/19）。读取失败时
 * 不做猜测性写入，任何错误都转化为 `failed`：不抛出、不重试、不记录日志。不支持的
 * 平台直接跳过，不访问 OS。
 *
 * Linux 的 nice 是线程级属性，按 PID 设置只覆盖线程组主线程；已存在的 Worker 和线程池
 * 不会被追溯调整（详见 docs/specs/process-priority.md）。本函数不是进程优先级的所有者，
 * 也不维护状态。
 */
export function lowerProcessPriority(
  pid: number | null | undefined,
  priority: ProcessPriority,
  options: LowerProcessPriorityOptions = {},
): ProcessPriorityResult {
  if (!SUPPORTED_PLATFORMS.has(options.platform ?? process.platform)) return "skipped";
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

  // Windows 与 Unix 的数值语义一致：数值越大表示调度优先级越低。已经不低于目标值时保持现状。
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
