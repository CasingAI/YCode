import { resolveExecutionState, type ExecutionState } from "@zcode/shared";
import {
  SESSION_ENTRY_EXECUTION_STATE,
  SessionEventType,
  type CollaborationMode,
  type TraceContext,
  type SessionId,
  type SessionEntryInfo,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "./internal.js";
import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "./permission-grant-recovery.js";

export function readRuntimeExecutionState(runtime: AgentRuntimeInternal): ExecutionState {
  return resolveExecutionState(runtime.config);
}

async function persistExecutionState(
  runtime: AgentRuntimeInternal,
  state = readRuntimeExecutionState(runtime),
): Promise<void> {
  if (!runtime.sessionPersisted || !runtime.sessionStore?.saveSessionEntry) return;
  await runtime.sessionStore.saveSessionEntry(buildExecutionStateEntry(runtime.sessionId, state));
}

export function buildExecutionStateEntry(
  sessionId: SessionId,
  state: ExecutionState,
): SessionEntryInfo {
  const timestamp = Date.now();
  return {
    id: `${sessionId}:runtime-execution-state`,
    sessionID: sessionId,
    type: SESSION_ENTRY_EXECUTION_STATE,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data: state,
  };
}

/** 权限、Plan 与只读是一个已消费状态；保存失败不发布成功快照，也不提前改内存。 */
export async function applyRuntimeExecutionState(
  runtime: AgentRuntimeInternal,
  input: { mode?: string },
  cause: { source: "command" | "tool"; toolCallId?: string; traceContext?: TraceContext },
): Promise<ExecutionState> {
  if (runtime.permissionFullAccessPending)
    throw new Error("Permission update is busy; retry mode change");
  if (unpublishedPermissionGrants.has(runtime)) await recoverPendingPermissionGrant(runtime);
  const previous = readRuntimeExecutionState(runtime);
  const next = resolveExecutionState(input, previous);
  if (next.mode === previous.mode) return next;
  // 受限档会让 Goal 的自主循环无法落盘，所以在进入方向上拦住。
  if (isRestrictedMode(next.mode) && !isRestrictedMode(previous.mode)) {
    const goal = await runtime.readSessionTargetForContext?.(
      cause.traceContext ?? runtime.rootTraceContext,
    );
    if (goal?.status === "active")
      throw new Error(
        next.mode === "plan"
          ? "Plan and Goal cannot be active at the same time."
          : "Ask mode and Goal cannot be active at the same time.",
      );
  }
  await persistExecutionState(runtime, next);
  runtime.config.mode = next.mode;
  // 进入计划模式时记下返回档，退出计划模式时清掉；非计划模式期间该字段无意义。
  runtime.config.prePlanMode = next.mode === "plan" ? toReturnMode(previous.mode) : undefined;
  const trace = cause.traceContext ?? runtime.rootTraceContext;
  await runtime.appendEvent(
    runtime.createEvent(
      SessionEventType.SessionModeChanged,
      {
        mode: next.mode,
        // 两个位是 mode 的派生投影，随事件一起带上以兼容仍读它们的消费点。
        planEnabled: next.mode === "plan",
        readOnlyEnabled: next.mode === "readonly",
        previousMode: previous.mode,
        previousPlanEnabled: previous.mode === "plan",
        previousReadOnlyEnabled: previous.mode === "readonly",
        source: cause.source,
        ...(cause.toolCallId ? { toolCallId: cause.toolCallId } : {}),
      },
      trace,
    ),
    trace,
  );
  return next;
}

function isRestrictedMode(mode: CollaborationMode): boolean {
  return mode === "plan" || mode === "readonly";
}

function toReturnMode(mode: CollaborationMode): Exclude<CollaborationMode, "plan"> {
  return mode === "plan" ? "yolo" : mode;
}
