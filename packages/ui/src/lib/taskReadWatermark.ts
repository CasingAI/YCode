import type { IZCodeTaskService } from "@zcode/services";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

const TERMINAL_SESSION_PHASES = new Set(["completedSuccess", "completedInterrupted", "error"]);

export interface TaskReadableSnapshot {
  control: { phase: string };
  lastActivityAt?: number;
}

export interface TaskSeenSelectionParams {
  snapshot: TaskReadableSnapshot | null | undefined;
  /** 主 pane 真实可见；分屏非 focused 仍算可见，隐藏 tab 不算。 */
  visible: boolean;
  documentVisible: boolean;
  /** conversation 投影窗口已连续接上会话尾部。 */
  contiguousToTail: boolean;
  /** 时间线仍在跟随最新一行。 */
  following: boolean;
  readOnly?: boolean;
  selectionSideChat?: boolean;
}

/** 复用 Host task service 的权威读取签名，调用方无需再做类型断言。 */
export type TaskReadWatermarkQueryService = Pick<IZCodeTaskService, "getTaskMeta">;

export type TaskTerminalNotificationDecision =
  | { show: true; reason: "unseen" | "query_failed" | "no_terminal_version" }
  | { show: false; reason: "seen" | "stale" };

export function isTerminalSessionPhase(phase: string | null | undefined): boolean {
  return typeof phase === "string" && TERMINAL_SESSION_PHASES.has(phase);
}

/**
 * 活动版本必须与 Host 的 `resolveTerminalActivityAt` 对齐：正的安全整数。
 * 0/负数/小数/NaN 都视为“旧事件无版本”，避免两端对同一帧做出不同裁决。
 */
export function isValidTerminalActivityVersion(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isValidSeenWatermark(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 只有用户真实看到终态正文且跟随到 tail 时，才把该快照自带的活动版本
 * 作为已读候选。列表 summary 可能领先正文，不能走到这里。
 */
export function selectTaskSeenActivityAt(params: TaskSeenSelectionParams): number | undefined {
  const { snapshot } = params;
  if (!snapshot) {
    return undefined;
  }
  if (
    !params.visible ||
    !params.documentVisible ||
    !params.contiguousToTail ||
    !params.following ||
    params.readOnly ||
    params.selectionSideChat
  ) {
    return undefined;
  }
  if (!isTerminalSessionPhase(snapshot.control.phase)) {
    return undefined;
  }
  return isValidTerminalActivityVersion(snapshot.lastActivityAt)
    ? snapshot.lastActivityAt
    : undefined;
}

export function isTerminalActivitySeen(params: {
  lastSeenActivityAt: number | undefined;
  terminalActivityAt: number | undefined;
}): boolean {
  const { lastSeenActivityAt, terminalActivityAt } = params;
  if (
    !isValidSeenWatermark(lastSeenActivityAt) ||
    !isValidTerminalActivityVersion(terminalActivityAt)
  ) {
    return false;
  }
  return terminalActivityAt <= lastSeenActivityAt;
}

export function buildTaskReadWatermarkKey(params: {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return [
    buildTaskWorkspaceKey(params.workspacePath, params.workspaceIdentity),
    params.taskId,
  ].join("\u0000");
}

export interface TaskSeenReporter {
  report(activityAt: number): void;
  dispose(): void;
  /** 等待当前和已合并的 seen 请求全部结束（成功或失败）。 */
  awaitIdle(): Promise<void>;
}

export interface CreateTaskSeenReporterParams {
  send: (activityAt: number) => Promise<unknown> | unknown;
  onError?: (error: unknown, activityAt: number) => void;
}

/**
 * 单 in-flight + 最大待发版本的 seen 上报器。
 *
 * - 只为成功提交的版本推进成功水位，失败后可重试；
 * - in-flight 期间的新版本只保留最大值，避免逐帧 RPC；
 * - dispose 只停止后续上报，不取消已经发出的请求。
 */
export function createTaskSeenReporter(params: CreateTaskSeenReporterParams): TaskSeenReporter {
  let disposed = false;
  let lastCommitted: number | undefined;
  let pending: number | undefined;
  let inFlight: Promise<void> | null = null;

  const pump = (): void => {
    if (disposed || inFlight || pending === undefined) {
      return;
    }
    const next = pending;
    pending = undefined;
    if (lastCommitted !== undefined && next <= lastCommitted) {
      // in-flight 期间收到的同版本/更旧版本，在成功后不再补发。
      return;
    }
    const run = (async () => {
      try {
        // 先让出一个微任务，保证 sync throw 不会在内层 finally 清空 inFlight
        // 之后才被下面的 `inFlight = run` 覆回一个已 settled Promise。
        await Promise.resolve();
        await params.send(next);
        if (disposed) {
          return;
        }
        if (lastCommitted === undefined || next > lastCommitted) {
          lastCommitted = next;
        }
      } catch (error) {
        params.onError?.(error, next);
      } finally {
        inFlight = null;
        pump();
      }
    })();
    inFlight = run;
  };

  return {
    report(activityAt) {
      if (disposed || !Number.isFinite(activityAt)) {
        return;
      }
      if (lastCommitted !== undefined && activityAt <= lastCommitted) {
        return;
      }
      if (pending === undefined || activityAt > pending) {
        pending = activityAt;
      }
      pump();
    },
    dispose() {
      disposed = true;
      pending = undefined;
    },
    async awaitIdle() {
      while (inFlight) {
        await inFlight;
      }
    },
  };
}

const seenReportersByKey = new Map<string, Set<TaskSeenReporter>>();

export function registerTaskSeenReporter(key: string, reporter: TaskSeenReporter): () => void {
  const reporters = seenReportersByKey.get(key) ?? new Set<TaskSeenReporter>();
  reporters.add(reporter);
  seenReportersByKey.set(key, reporters);
  return () => {
    reporters.delete(reporter);
    if (reporters.size === 0 && seenReportersByKey.get(key) === reporters) {
      seenReportersByKey.delete(key);
    }
  };
}

/**
 * 通知裁决前等待本端已发出的正文已读请求。这里只等待瞬时 Promise，
 * 不把 renderer 变成第二套持久水位。
 */
export function awaitPendingTaskSeen(key: string): Promise<void> {
  const reporters = seenReportersByKey.get(key);
  if (!reporters || reporters.size === 0) {
    return Promise.resolve();
  }
  return Promise.all([...reporters].map((reporter) => reporter.awaitIdle())).then(() => undefined);
}

export interface ResolveTerminalNotificationDecisionParams {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  terminalActivityAt?: number;
  service: TaskReadWatermarkQueryService | null | undefined;
  awaitPendingSeen?: () => Promise<void>;
  isCurrent?: () => boolean;
}

/**
 * 终态通知的 Host 水位裁决。查询失败保留原通知行为（fail open），
 * 但原 workspace/连接代际失效时必须丢弃结果。
 */
export async function resolveTerminalNotificationDecision(
  params: ResolveTerminalNotificationDecisionParams,
): Promise<TaskTerminalNotificationDecision> {
  const terminalActivityAt = params.terminalActivityAt;
  if (!isValidTerminalActivityVersion(terminalActivityAt)) {
    return { show: true, reason: "no_terminal_version" };
  }

  if (params.awaitPendingSeen) {
    try {
      await params.awaitPendingSeen();
    } catch {
      // 等待本端 seen 失败不改变 notify 语义，继续用 Host 水位裁决。
    }
  }
  if (params.isCurrent && !params.isCurrent()) {
    return { show: false, reason: "stale" };
  }

  if (!params.service) {
    return { show: true, reason: "query_failed" };
  }

  try {
    const meta = await params.service.getTaskMeta({
      taskId: params.taskId,
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    });
    if (params.isCurrent && !params.isCurrent()) {
      return { show: false, reason: "stale" };
    }
    if (
      isTerminalActivitySeen({
        lastSeenActivityAt: meta?.lastSeenActivityAt,
        terminalActivityAt,
      })
    ) {
      return { show: false, reason: "seen" };
    }
    return { show: true, reason: "unseen" };
  } catch {
    if (params.isCurrent && !params.isCurrent()) {
      return { show: false, reason: "stale" };
    }
    return { show: true, reason: "query_failed" };
  }
}
