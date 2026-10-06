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
  // 受限档会让 Goal 的自主循环无法落盘，所以进入前必须先把 Goal 收口。
  if (isRestrictedMode(next.mode) && !isRestrictedMode(previous.mode)) {
    const trace = cause.traceContext ?? runtime.rootTraceContext;
    const goal = await runtime.readSessionTargetForContext?.(trace);
    if (goal?.status === "active") {
      // 冲突要裁决而不是拒绝。判据是 Goal 的 status 本身，而不是「当前有没有活跃 turn」：
      // status 才是 Goal 续跑的开关（turn 开头读它，非 active 就不带 Goal 续跑），
      // 把它收成 paused 就足以让这次模式切换成立。
      //
      // 正在跑的 turn 不需要、也不应该被中断，中途收口是安全的：
      // - updateTargetStatus 只改 status，不清 active_input_id / active_run_started_at 租约，
      //   所以当前 turn 收尾时 finishTargetRun 仍能正常累加 tokens/time，不丢账；
      // - 工具权限是每次执行实时读 config.mode 的，切档立刻对在跑的 turn 生效；
      // - 下一个 turn 起读到 paused，Goal 不再自主续跑。
      // 这三件事合起来说明「Goal 已暂停」与「turn 仍在跑」不是矛盾状态，不需要为此拒绝用户。
      const paused = await runtime.sessionStore?.updateTargetStatus?.({
        sessionID: runtime.sessionId,
        status: "paused",
      });
      if (paused) {
        await runtime.recordTargetChanged({
          action: "status_updated",
          previousTarget: goal,
          source: "runtime",
          target: paused,
          traceContext: trace,
        });
      }
    }
  }
  await persistExecutionState(runtime, next);
  runtime.config.mode = next.mode;
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

