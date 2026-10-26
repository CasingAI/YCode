import type { V4SessionRecordView } from "../types.js";

/** 等 idle 轮询参数：25ms 间隔、5s 超时。 */
const IDLE_POLL_INTERVAL_MS = 25;
const IDLE_POLL_TIMEOUT_MS = 5_000;

/** 等 idle 超时（active turn 的 finally 5s 内未释放锁）→ 放弃重发并报错。 */
export class V4SessionIdleTimeoutError extends Error {
  constructor(sessionId: string) {
    super(`v4 timed out waiting for session idle: ${sessionId}`);
    this.name = "V4SessionIdleTimeoutError";
  }
}

/**
 * 轮询等 Bootstrap turn 与 Core foreground command 的 finally 都释放 authority。
 * options.excludeForegroundPromotionLeaseId：调用方自己持有的 promotion lease 不算
 * busy（否则持有 lease 等空闲位的一方永远看到自己而超时）；其余 busy 信号
 * （drain 活动、命令队列、activeTurn、reservation）全部纳入轮询——只看
 * activeAbortController/foreground execution 会在旧 turn 收尾窗口误判 idle，
 * 把重发输入推进队列（specs/message-history-edit.md 规则 18）。
 */
export async function waitForSessionIdle(
  record: V4SessionRecordView,
  options?: { excludeForegroundPromotionLeaseId?: string },
): Promise<void> {
  const deadline = Date.now() + IDLE_POLL_TIMEOUT_MS;
  while (
    record.activeAbortController !== undefined ||
    record.app.runtime?.hasActiveOrQueuedTurnWork?.({
      excludeForegroundPromotionLeaseId: options?.excludeForegroundPromotionLeaseId,
    }) === true
  ) {
    if (Date.now() >= deadline) {
      throw new V4SessionIdleTimeoutError(record.app.sessionId);
    }
    await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_INTERVAL_MS));
  }
}

/**
 * completed 表示成功事件已准入、提交保护尚未释放。此时不能 abort，也不能只等
 * session idle：同一 runtime command 的成功提交后还可能进入 verifier/continuation，
 * 只要还有可取消的 goal work，session 就不会 idle。
 *
 * 用 Core 返回的 execution id 作为 guard 轮询：保护释放后继续取消同一个 execution；
 * 一旦 idle（已结束）或 mismatch（新 execution 已接手）立即停止，绝不改停新执行。
 * 这里不设放弃超时——固定超时会在保护仍持有时放行后续调度，正是 spec 禁止的掩盖。
 */
export async function stopAfterSuccessCommitReleased(
  record: V4SessionRecordView,
  options: {
    expectedForegroundExecutionId: string;
    preserveQueueAutoDrainOnCancel: boolean;
    reason: string;
  },
) {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_INTERVAL_MS));
    const result = record.app.runtime?.stopActiveForegroundExecution?.({
      expectedForegroundExecutionId: options.expectedForegroundExecutionId,
      preserveQueueAutoDrainOnCancel: options.preserveQueueAutoDrainOnCancel,
      reason: options.reason,
    });
    if (result?.kind !== "completed") {
      return result;
    }
  }
}
