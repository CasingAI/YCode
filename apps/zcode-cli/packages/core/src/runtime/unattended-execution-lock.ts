import {
  CoreErrorType,
  SESSION_ENTRY_UNATTENDED_EXECUTION_LOCK,
  createCoreError,
  type QueryId,
  type SessionEntryInfo,
  type SessionId,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "./internal.js";

/**
 * 无人值守执行锁：锁的唯一 owner 是 runtime 的内存布尔值，session entry 只是
 * 冷恢复快照。加锁与解锁都必须先写盘成功再改内存，避免「本地已锁/已解锁」的假成功。
 *
 * 所有锁写入都串行经过 runtime.unattendedLockTransition：加锁（自动化 turn）与
 * 解锁（人工消息接纳）可能同时发生，只有同一条 FIFO 才能保证最终状态与接纳顺序一致。
 * 人工接纳在上锁之前发生时，加锁通过 humanInputEpoch 基线放弃本次锁，不会在人工
 * 消息已被接受后把 turn 重新锁上。
 */

const AUTOMATION_INPUT_ID_PREFIX = "automation-";
const OFF_PEAK_INPUT_ID_PREFIX = "offpeak-";

export const UNATTENDED_MODE_SWITCH_BLOCKED_MESSAGE =
  "Automation is running unattended; mode switching is blocked until a new user message.";

const UNATTENDED_LOCK_PERSIST_FAILED_MESSAGE =
  "Failed to persist the unattended execution lock; refusing to continue.";

export interface UnattendedAttributionInput {
  automationId?: string;
  offPeakTaskId?: string;
  queryId?: QueryId | string;
  /** 部分派发只带 inputId（=queryId）而不带显式归因，前缀兜底同样适用。 */
  inputId?: string;
}

/** 自动化归因是锁的主信号；queryId/inputId 前缀沿用自动派发现有的命名兜底。 */
export function hasAutomationAttribution(input: UnattendedAttributionInput): boolean {
  if (input.automationId?.trim()) return true;
  if (input.offPeakTaskId?.trim()) return true;
  const ids = [input.queryId, input.inputId];
  return ids.some((rawId) => {
    const id = rawId?.trim();
    if (!id) return false;
    return id.startsWith(AUTOMATION_INPUT_ID_PREFIX) || id.startsWith(OFF_PEAK_INPUT_ID_PREFIX);
  });
}

export function unattendedExecutionLockEntryId(sessionId: SessionId): string {
  return `${sessionId}:runtime-unattended-execution-lock`;
}

export function buildUnattendedExecutionLockEntry(
  sessionId: SessionId,
  locked: boolean,
): SessionEntryInfo {
  const timestamp = Date.now();
  return {
    id: unattendedExecutionLockEntryId(sessionId),
    sessionID: sessionId,
    type: SESSION_ENTRY_UNATTENDED_EXECUTION_LOCK,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data: { locked },
  };
}

function parseLocked(data: unknown): boolean {
  return (
    typeof data === "object" && data !== null && (data as { locked?: unknown }).locked === true
  );
}

/**
 * 锁写入要求 save + read 同一能力：只能写不能读的 store 会让锁在冷恢复时静默丢失，
 * 因此这种 store 上直接拒绝自动化执行（fail closed），而不是写一条永远读不回来的 entry。
 * 未使用锁的会话不受影响。
 */
function hasLockPersistenceCapability(runtime: AgentRuntimeInternal): boolean {
  return (
    runtime.sessionPersisted &&
    typeof runtime.sessionStore?.saveSessionEntry === "function" &&
    typeof runtime.sessionStore.sessionEntries === "function"
  );
}

async function persistLock(runtime: AgentRuntimeInternal, locked: boolean): Promise<void> {
  if (!hasLockPersistenceCapability(runtime)) {
    throw createCoreError(CoreErrorType.StorageError, UNATTENDED_LOCK_PERSIST_FAILED_MESSAGE, {
      context: { sessionId: runtime.sessionId, locked },
    });
  }
  try {
    await runtime.sessionStore!.saveSessionEntry!(
      buildUnattendedExecutionLockEntry(runtime.sessionId, locked),
    );
  } catch (error) {
    throw createCoreError(CoreErrorType.StorageError, UNATTENDED_LOCK_PERSIST_FAILED_MESSAGE, {
      cause: error instanceof Error ? error : undefined,
      context: { sessionId: runtime.sessionId, locked },
    });
  }
}

/**
 * 锁写入串行链：后入队的操作一定看到前一个操作完成后的内存状态。
 * 前一个操作失败不能阻断后续操作，否则一次写盘失败会把锁永久卡在旧状态。
 */
function runUnattendedLockTransition<T>(
  runtime: AgentRuntimeInternal,
  action: () => Promise<T>,
): Promise<T> {
  const run = runtime.unattendedLockTransition.then(action, action);
  runtime.unattendedLockTransition = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 自动化 turn 在首次模型请求前确认锁。
 * 写盘失败必须向上抛错：调用方据此拒绝执行，不能退化为仅内存锁。
 * humanInputEpochAtStart 是 admission 在第一个 await 之前捕获的人工接纳基线；
 * 两者不同说明启动窗口内已经有人工消息被真正接纳，本次 turn 不再上锁。
 */
export async function ensureUnattendedExecutionLock(
  runtime: AgentRuntimeInternal,
  input: UnattendedAttributionInput | undefined,
  humanInputEpochAtStart?: number,
): Promise<void> {
  if (!input || !hasAutomationAttribution(input)) return;
  await runUnattendedLockTransition(runtime, async () => {
    if (runtime.unattendedExecutionLocked) return;
    if (
      humanInputEpochAtStart !== undefined &&
      runtime.unattendedHumanInputEpoch !== humanInputEpochAtStart
    ) {
      return;
    }
    await persistLock(runtime, true);
    runtime.unattendedExecutionLocked = true;
  });
}

async function runUnlockTransition(runtime: AgentRuntimeInternal): Promise<void> {
  await runUnattendedLockTransition(runtime, async () => {
    if (!runtime.unattendedExecutionLocked) return;
    await persistLock(runtime, false);
    runtime.unattendedExecutionLocked = false;
  });
}

/**
 * 尚未完成接纳 commit 的人工输入（idle 预留阶段）解锁。
 * 解锁写盘失败必须抛给调用方：此时消息还没被接纳，调用方释放预留并按失败上报。
 * 接纳计数只在解锁成功后推进，失败不得被当成「人工已到达」。
 */
export async function unlockUnattendedExecutionForHumanInput(
  runtime: AgentRuntimeInternal,
  input: UnattendedAttributionInput & { unlocksUnattendedModeSwitch?: boolean },
): Promise<void> {
  if (input.unlocksUnattendedModeSwitch !== true) return;
  if (hasAutomationAttribution(input)) return;
  // 即使当前未锁定也进入串行链：可能有一个尚未完成的加锁操作，必须排在它后面，
  // 不能因为读到「此刻未锁」就提前返回。
  await runUnlockTransition(runtime);
  runtime.unattendedHumanInputEpoch += 1;
}

/**
 * 已完成接纳 commit 的人工输入（steer / deferred queue 事件已提交）解锁。
 * 消息已经入队，解锁写盘失败不能把它报成失败——调用方会重发同一句，造成重复输入。
 * 因此吞掉写盘错误、保持 locked:true 并记录警告；输入仍是 accepted，接纳计数照常推进，
 * 后续人工消息会再次尝试解锁。
 */
export async function unlockUnattendedExecutionForAcceptedInput(
  runtime: AgentRuntimeInternal,
  input: UnattendedAttributionInput & { unlocksUnattendedModeSwitch?: boolean },
): Promise<void> {
  if (input.unlocksUnattendedModeSwitch !== true) return;
  if (hasAutomationAttribution(input)) return;
  runtime.unattendedHumanInputEpoch += 1;
  try {
    await runUnlockTransition(runtime);
  } catch (error) {
    runtime.logger?.warn("Failed to persist unattended execution unlock for accepted input", {
      event: "unattended.unlock_persist_failed",
      sessionId: runtime.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 冷恢复只按最后一条 entry 还原内存锁，不自动解锁。
 * 只有明确的 locked:true 才会置锁；读取能力缺席时保持未锁（这种 store 也无法写锁）。
 */
export async function restoreUnattendedExecutionLockFromStore(
  runtime: AgentRuntimeInternal,
): Promise<void> {
  const entries = await runtime.sessionStore?.sessionEntries?.({
    sessionID: runtime.sessionId,
    type: SESSION_ENTRY_UNATTENDED_EXECUTION_LOCK,
  });
  if (parseLocked(entries?.at(-1)?.data)) {
    runtime.unattendedExecutionLocked = true;
  }
}
