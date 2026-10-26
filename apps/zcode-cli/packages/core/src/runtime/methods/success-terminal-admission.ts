import { CoreErrorType, createCoreError } from "../deps.js";
import type { SessionEvent } from "../deps.js";
import { createTurnCancelledError, throwIfTurnAborted } from "../helpers/turn-errors.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ActiveForegroundExecutionState } from "../types.js";
import { isSessionEventStoredError } from "./events.js";

/**
 * 成功终态准入 token。
 *
 * `committed` 只在成功事件 append 成功后置位；仅持有 token 不代表事件已落库。
 * 收口时必须用 `isSuccessTerminalEventCommitted` 回查权威事件流，不能因为
 * token 存在就跳过真实故障处理。
 */
export interface SuccessTerminalAdmission {
  committed: boolean;
  execution?: ActiveForegroundExecutionState;
}

/**
 * 在成功事件 append 前同步检查取消并锁定当前 foreground execution。
 *
 * 准入后 Stop 返回 completed，不再 abort；因此这里的检查和加锁必须是同一个
 * 同步步，不能中间插入 await。没有 foreground owner 时仍然必须检查 signal。
 */
export function admitSuccessTerminal(
  this: AgentRuntimeInternal,
  signal?: AbortSignal,
): SuccessTerminalAdmission {
  throwIfTurnAborted(signal);
  const execution = this.activeForegroundExecution;
  if (!execution) return { committed: false };
  if (execution.controller.signal.aborted) {
    throw createTurnCancelledError(execution.controller.signal.reason);
  }
  if (execution.successTerminalAdmitted) {
    throw createCoreError(
      CoreErrorType.InvalidStateTransition,
      "Success terminal already admitted for the active foreground execution",
      {
        context: { foregroundExecutionId: execution.foregroundExecutionId },
        recoverable: false,
      },
    );
  }
  execution.successTerminalAdmitted = true;
  return { committed: false, execution };
}

export function markSuccessTerminalCommitted(admission: SuccessTerminalAdmission): void {
  admission.committed = true;
}

export function releaseSuccessTerminal(admission?: SuccessTerminalAdmission): void {
  if (!admission?.execution) return;
  admission.execution.successTerminalAdmitted = false;
  admission.execution = undefined;
}

/**
 * 判断成功事件是否已经被权威事件流接受。
 *
 * appendEvent 可能先写入 eventStore 再在 notifyEventSinks 拒绝；仅看本地
 * `events` 数组会漏掉这种部分提交。优先使用本地已推送事实，其次使用
 * appendEvent 打在错误上的 store 标记，最后回查 eventStore。
 */
export async function isSuccessTerminalEventCommitted(
  this: AgentRuntimeInternal,
  event: SessionEvent | undefined,
  events: readonly SessionEvent[],
  error: unknown,
): Promise<boolean> {
  if (!event) return false;
  if (events.some((candidate) => candidate.id === event.id)) return true;
  if (isSessionEventStoredError(error)) return true;
  try {
    const stored = await this.eventStore.getEvents(this.sessionId);
    return stored.some((candidate) => candidate.id === event.id);
  } catch {
    return false;
  }
}
