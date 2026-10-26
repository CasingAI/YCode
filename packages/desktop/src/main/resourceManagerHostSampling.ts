import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import {
  HostMessageTypes,
  type HostResourceUsageProcess,
  type HostResourceUsageSnapshotResultResponse,
  type ResourceUsageSamplingStatus,
} from "@zcode/shared";

/**
 * 资源管理器 main → Host 采样 fan-out。
 * 每次快照按 requestId 向每个存活 Host 发一次请求；展示等待超时用缓存兜底，
 * 但底层请求继续等待迟到回帖，超过独立期限才取消并释放，下一轮刷新可重试。
 */

/** 单次展示等待上限；到点返回 pending/stale，不打断底层采样 */
export const HOST_SNAPSHOT_TIMEOUT_MS = 900;
/**
 * 底层采样完成期限：Windows 进程表查询最多 5s，Agent 元数据 800ms 并行，
 * 留出调度余量。超过后取消请求，避免无回帖时永久锁住同一 Host。
 */
export const HOST_SNAPSHOT_DEADLINE_MS = 6_500;

/** 一次 Host 请求的展示结果；samplingStatus 为 complete 才代表本轮成功完整采样 */
export interface HostResourceUsageRequestResult {
  processes: HostResourceUsageProcess[];
  samplingStatus: ResourceUsageSamplingStatus;
}

interface DisplayWaiter {
  settle: (result: HostResourceUsageRequestResult) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface PendingHostSampling {
  label: string;
  child: Pick<ElectronUtilityProcess, "postMessage">;
  requestId: string;
  waiters: Set<DisplayWaiter>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  /** 已挂载的 abort signal；同一 signal 只注册一次。 */
  abortSignals: Set<AbortSignal>;
  /** 当前调用注册的 abort 监听；底层结束或取消时统一移除。 */
  abortCleanups: Set<() => void>;
}

const pendingByLabel = new Map<string, PendingHostSampling>();
const pendingByRequestId = new Map<string, PendingHostSampling>();
/** 只有成功完整回帖会写入成功缓存。 */
const lastCompleteResults = new Map<string, HostResourceUsageProcess[]>();
/**
 * 未被任何展示 waiter 收到的最近成功结果。
 * Windows 进程表稳定慢于 900ms 时，迟到成功先落在这里；下一轮 poll 可消费一次并按 complete 交付。
 */
const freshCompleteLabels = new Set<string>();

function postCancel(sampling: PendingHostSampling): void {
  try {
    sampling.child.postMessage({
      type: HostMessageTypes.ResourceUsageSnapshotCancel,
      requestId: sampling.requestId,
    });
  } catch {
    /* Host 已退出，无需继续取消。 */
  }
}

function finishSampling(sampling: PendingHostSampling): void {
  if (sampling.deadlineTimer) clearTimeout(sampling.deadlineTimer);
  sampling.deadlineTimer = undefined;
  for (const cleanup of sampling.abortCleanups) cleanup();
  sampling.abortCleanups.clear();
  sampling.abortSignals.clear();
  if (pendingByLabel.get(sampling.label) === sampling) pendingByLabel.delete(sampling.label);
  if (pendingByRequestId.get(sampling.requestId) === sampling) {
    pendingByRequestId.delete(sampling.requestId);
  }
}

function settleWaiter(waiter: DisplayWaiter, result: HostResourceUsageRequestResult): void {
  if (waiter.timer) clearTimeout(waiter.timer);
  waiter.timer = undefined;
  waiter.settle(result);
}

function settleAll(sampling: PendingHostSampling, result: HostResourceUsageRequestResult): void {
  for (const waiter of sampling.waiters) {
    sampling.waiters.delete(waiter);
    settleWaiter(waiter, result);
  }
}

/** 回退缓存只返回 stale；没有缓存时由调用方决定 pending/failed。 */
function staleResult(label: string): HostResourceUsageRequestResult | undefined {
  const complete = lastCompleteResults.get(label);
  if (complete) return { processes: complete, samplingStatus: "stale" };
  return undefined;
}

/** 取走一次未被展示 waiter 收到的成功结果；消费后同一旧值只能是 stale。 */
function consumeFreshComplete(label: string): HostResourceUsageProcess[] | undefined {
  if (!freshCompleteLabels.delete(label)) return undefined;
  return lastCompleteResults.get(label);
}

function abortSampling(label: string): void {
  const active = pendingByLabel.get(label);
  if (!active) return;
  postCancel(active);
  finishSampling(active);
  // 窗口关闭/Host 退出后旧样本不再复用。
  lastCompleteResults.delete(label);
  freshCompleteLabels.delete(label);
  settleAll(active, { processes: [], samplingStatus: "failed" });
}

function attachAbort(sampling: PendingHostSampling, signal: AbortSignal | undefined): void {
  if (!signal || sampling.abortSignals.has(signal)) return;
  sampling.abortSignals.add(signal);
  const cancel = (): void => abortSampling(sampling.label);
  signal.addEventListener("abort", cancel, { once: true });
  sampling.abortCleanups.add(() => signal.removeEventListener("abort", cancel));
}

/** 启动且只启动一轮底层采样；postMessage 失败时释放并返回 undefined。 */
function beginSampling(
  label: string,
  child: Pick<ElectronUtilityProcess, "postMessage">,
  deadlineMs: number,
): PendingHostSampling | undefined {
  const sampling: PendingHostSampling = {
    label,
    child,
    requestId: randomUUID(),
    waiters: new Set(),
    abortSignals: new Set(),
    abortCleanups: new Set(),
  };
  sampling.deadlineTimer = setTimeout(() => {
    if (pendingByLabel.get(label) !== sampling) return;
    // 底层一直无回帖：取消以释放 Host 与 requestId，下次刷新重新采样。
    postCancel(sampling);
    finishSampling(sampling);
    freshCompleteLabels.delete(label);
    const fallback =
      staleResult(label) ??
      ({ processes: [], samplingStatus: "failed" } satisfies HostResourceUsageRequestResult);
    settleAll(sampling, fallback);
  }, deadlineMs);
  pendingByLabel.set(label, sampling);
  pendingByRequestId.set(sampling.requestId, sampling);

  try {
    child.postMessage({
      type: HostMessageTypes.ResourceUsageSnapshotRequest,
      requestId: sampling.requestId,
    });
    return sampling;
  } catch {
    /* Host 已退出：按失败返回，并允许下一轮重建请求。 */
    finishSampling(sampling);
    return undefined;
  }
}

/** desktopHostProcess 收到 Host 回帖时调用 */
export function resolveHostResourceUsageResult(
  label: string,
  result: HostResourceUsageSnapshotResultResponse,
): void {
  const sampling = pendingByRequestId.get(result.requestId);
  // 关闭/重开后的旧结果不得写回新采样会话；requestId 也必须属于回帖 Host。
  if (!sampling || sampling.label !== label) return;
  const complete = (result.samplingStatus ?? "complete") === "complete";
  const delivered = sampling.waiters.size > 0;
  if (complete) {
    lastCompleteResults.set(label, result.processes);
    // 没有 waiter 收到（典型是 Windows 采样晚于 900ms 展示等待）时保留一次 fresh，
    // 让后续 poll 能真正展示 complete；已交付的结果不能再被当成新鲜值重复交付。
    if (delivered) freshCompleteLabels.delete(label);
    else freshCompleteLabels.add(label);
  } else {
    // 失败后不能把先前的成功缓存当成新鲜完整结果；旧值最多只能 stale 展示。
    freshCompleteLabels.delete(label);
  }
  finishSampling(sampling);
  settleAll(sampling, {
    processes: result.processes,
    samplingStatus: complete ? "complete" : "failed",
  });
}

/** Host 退出时取消在途请求并清掉它的缓存 */
export function forgetHostResourceUsage(label: string): void {
  const sampling = pendingByLabel.get(label);
  if (sampling) {
    postCancel(sampling);
    finishSampling(sampling);
    settleAll(sampling, { processes: [], samplingStatus: "failed" });
  }
  lastCompleteResults.delete(label);
  freshCompleteLabels.delete(label);
}

/**
 * 请求某个 Host 的资源快照。
 *
 * - 同一 Host 最多一个在途底层采样，不按 UI 刷新周期重复请求；
 * - timeoutMs 只限制展示等待，超时返回 pending/stale 并继续等待迟到回帖；
 * - 迟到但未被展示 waiter 收到的成功结果保留一次 fresh，下一次 poll 直接按 complete 交付，
 *   并在同一 poll 启动下一轮（仍保持每轮最多一个请求）；
 * - deadlineMs 是底层完成期限，超时取消请求并释放，下一次请求可重试；
 * - 取消或旧 requestId 的回帖不会写入新生命周期。
 */
export function requestHostResourceUsage(
  label: string,
  child: Pick<ElectronUtilityProcess, "postMessage">,
  timeoutMs: number = HOST_SNAPSHOT_TIMEOUT_MS,
  signal?: AbortSignal,
  deadlineMs: number = HOST_SNAPSHOT_DEADLINE_MS,
): Promise<HostResourceUsageRequestResult> {
  if (signal?.aborted) {
    return Promise.resolve({ processes: [], samplingStatus: "failed" });
  }

  const fresh = consumeFreshComplete(label);
  if (fresh) {
    // 先交付上一轮迟到成功，再以同一 poll 启动下一轮；不额外排队，也不会重复采样。
    let active = pendingByLabel.get(label);
    if (!active) {
      active = beginSampling(label, child, deadlineMs);
      if (!active) {
        // 新一轮连请求都没发出去时，不能把 fresh 报成 complete；留到下次成功启动再消费。
        freshCompleteLabels.add(label);
        return Promise.resolve({ processes: [], samplingStatus: "failed" });
      }
    }
    attachAbort(active, signal);
    return Promise.resolve({ processes: fresh, samplingStatus: "complete" });
  }

  return new Promise((resolve) => {
    let settled = false;
    const waiter: DisplayWaiter = {
      settle: (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      },
    };
    const finishWaiter = (result: HostResourceUsageRequestResult): void => {
      if (settled) return;
      settleWaiter(waiter, result);
    };

    let sampling = pendingByLabel.get(label);
    if (!sampling) {
      sampling = beginSampling(label, child, deadlineMs);
      if (!sampling) {
        resolve({
          processes: staleResult(label)?.processes ?? [],
          samplingStatus: "failed",
        });
        return;
      }
    }
    // 在途请求可能由没有 signal 的调用创建；后到调用带 signal 时也必须能取消。
    attachAbort(sampling, signal);

    sampling.waiters.add(waiter);
    waiter.timer = setTimeout(() => {
      sampling?.waiters.delete(waiter);
      finishWaiter(staleResult(label) ?? { processes: [], samplingStatus: "pending" });
    }, timeoutMs);
  });
}
