// ============================================================
// Sandbox 后台执行：快照类型、ID 前缀与登记/等待/窗口
// ============================================================
// 从 instance-table.ts 拆出（超 400 行门限）：后台登记先行（超时/取消时 ID 已
// 存在），JS 在活实例里继续跑；停止从不打断 JS。状态更新、落盘、waiter 唤醒仍
// 由调用方（实例表）提供回调，本文件只管快照表的纯操作，不持有实例。

import type { SessionId } from "@zcode/contracts";

/** 沙盒后台执行的实例表侧状态（TaskOutput 投影与 waiter 的事实源）。 */
export interface SandboxBackgroundEvalSnapshot {
  taskId: string;
  sessionId: SessionId;
  status: "running" | "completed" | "failed";
  /** 该次调用开始时的 console 水位（窗口下界）。 */
  fromSeq: number;
  startedAt: Date;
  completedAt?: Date;
  returnText?: string;
  error?: { code: string; message: string };
  consoleTruncated?: boolean;
  /** 新建实例后的第一次调用为 true（调用方据此包一次新实例提示，只写一次）。 */
  isFirstResultOnNewInstance?: boolean;
}

export const SANDBOX_BACKGROUND_TASK_ID_PREFIX = "sandbox_";

/** 后台快照表：taskId → 快照；waiter 表：taskId → 终态等待者集合。 */
export interface SandboxBackgroundTables {
  backgroundEvals: Map<string, SandboxBackgroundEvalSnapshot>;
  backgroundWaiters: Map<string, Set<(snapshot: SandboxBackgroundEvalSnapshot) => void>>;
}

export function createSandboxBackgroundTables(): SandboxBackgroundTables {
  return { backgroundEvals: new Map(), backgroundWaiters: new Map() };
}

/** 后台执行的快照（TaskOutput 投影与 lifecycleProvider 快照源的事实源）。 */
export function getSandboxBackgroundEval(
  tables: SandboxBackgroundTables,
  taskId: string,
): SandboxBackgroundEvalSnapshot | undefined {
  return tables.backgroundEvals.get(taskId);
}

/** 新建一条 running 快照并登记，返回 taskId（`sandbox_` 前缀）。 */
export function registerSandboxBackgroundEval(
  tables: SandboxBackgroundTables,
  input: {
    sessionId: SessionId;
    fromSeq: number;
    isFirstResultOnNewInstance: boolean;
  },
): { taskId: string; snapshot: SandboxBackgroundEvalSnapshot } {
  const taskId = `${SANDBOX_BACKGROUND_TASK_ID_PREFIX}${crypto.randomUUID().replace(/-/g, "")}`;
  const snapshot: SandboxBackgroundEvalSnapshot = {
    taskId,
    sessionId: input.sessionId,
    status: "running",
    fromSeq: input.fromSeq,
    startedAt: new Date(),
    ...(input.isFirstResultOnNewInstance ? { isFirstResultOnNewInstance: true } : {}),
  };
  tables.backgroundEvals.set(taskId, snapshot);
  return { taskId, snapshot };
}

/** 后台结算：completed / failed 写回快照；未知形态删条目。 */
export function settleSandboxBackgroundEval(
  tables: SandboxBackgroundTables,
  taskId: string,
  result:
    | { kind: "completed"; returnText?: string; consoleTruncated?: boolean }
    | { kind: "failed"; error: { code: string; message: string } }
    | { kind: "other" },
): SandboxBackgroundEvalSnapshot | undefined {
  const snapshot = tables.backgroundEvals.get(taskId);
  if (!snapshot) return undefined;
  if (result.kind === "completed") {
    const settled: SandboxBackgroundEvalSnapshot = {
      ...snapshot,
      status: "completed",
      completedAt: new Date(),
      ...(result.returnText !== undefined ? { returnText: result.returnText } : {}),
      ...(result.consoleTruncated ? { consoleTruncated: true } : {}),
    };
    tables.backgroundEvals.set(taskId, settled);
    return settled;
  }
  if (result.kind === "failed") {
    const settled: SandboxBackgroundEvalSnapshot = {
      ...snapshot,
      status: "failed",
      completedAt: new Date(),
      error: result.error,
    };
    tables.backgroundEvals.set(taskId, settled);
    return settled;
  }
  tables.backgroundEvals.delete(taskId);
  return undefined;
}

/** 唤醒该 taskId 的全部 waiter（结算后调用；无 waiter 即空操作）。 */
export function notifySandboxBackgroundWaiters(
  tables: SandboxBackgroundTables,
  taskId: string,
  settled: SandboxBackgroundEvalSnapshot,
): void {
  const waiters = tables.backgroundWaiters.get(taskId);
  tables.backgroundWaiters.delete(taskId);
  for (const waiter of waiters ?? []) waiter(settled);
}

/** 等待后台执行终态（TaskOutput block=true 用；abort 即返回当前快照）。 */
export function waitForSandboxBackgroundEval(
  tables: SandboxBackgroundTables,
  taskId: string,
  options?: { signal?: AbortSignal },
): Promise<SandboxBackgroundEvalSnapshot | undefined> {
  const current = tables.backgroundEvals.get(taskId);
  if (!current || current.status !== "running") return Promise.resolve(current);
  if (options?.signal?.aborted) return Promise.resolve(current);
  return new Promise((resolve) => {
    const waiter = (snapshot: SandboxBackgroundEvalSnapshot) => resolve(snapshot);
    let waiters = tables.backgroundWaiters.get(taskId);
    if (!waiters) {
      waiters = new Set();
      tables.backgroundWaiters.set(taskId, waiters);
    }
    waiters.add(waiter);
    options?.signal?.addEventListener(
      "abort",
      () => {
        waiters?.delete(waiter);
        resolve(tables.backgroundEvals.get(taskId));
      },
      { once: true },
    );
  });
}

/**
 * 会话实例死亡时该会话的后台 ID 全部失效（旧 ID 读取失败），waiter 按终态唤醒。
 * 返回受影响的 taskId 列表（调用方据此做额外清理，默认空操作）。
 */
export function failSandboxBackgroundEvalsForSession(
  tables: SandboxBackgroundTables,
  sessionId: SessionId,
): string[] {
  const failed: string[] = [];
  for (const [taskId, snapshot] of tables.backgroundEvals) {
    if (snapshot.sessionId !== sessionId) continue;
    tables.backgroundEvals.delete(taskId);
    failed.push(taskId);
    const waiters = tables.backgroundWaiters.get(taskId);
    tables.backgroundWaiters.delete(taskId);
    const terminal: SandboxBackgroundEvalSnapshot = {
      ...snapshot,
      status: "failed",
      completedAt: new Date(),
      error: { code: "sandbox_disposed", message: "沙盒实例已销毁" },
    };
    for (const waiter of waiters ?? []) waiter(terminal);
  }
  return failed;
}
