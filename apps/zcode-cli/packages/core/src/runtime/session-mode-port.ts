import type { SessionModePort } from "./deps.js";
import type { AgentRuntimeInternal } from "./internal.js";
import { applyRuntimeExecutionState, readRuntimeExecutionState } from "./execution-state.js";
import { UNATTENDED_MODE_SWITCH_BLOCKED_MESSAGE } from "./unattended-execution-lock.js";

export function createRuntimeSessionModePort(runtime: AgentRuntimeInternal): SessionModePort {
  return {
    supportsPermissionFullAccess: () => Boolean(runtime.sessionStore?.commitPermissionFullAccess),
    getMode: () => readRuntimeExecutionState(runtime).mode,
    // 权限轴是单值，两个 isXxxEnabled 只是既有调用点的派生查询。
    isPlanEnabled: () => readRuntimeExecutionState(runtime).mode === "plan",
    isReadOnlyEnabled: () => readRuntimeExecutionState(runtime).mode === "readonly",
    // 给工具层一个可读失败；真正的硬拒绝仍由 applyRuntimeExecutionState 兜底。
    getModeSwitchRestriction: () =>
      runtime.unattendedExecutionLocked
        ? { reason: UNATTENDED_MODE_SWITCH_BLOCKED_MESSAGE }
        : undefined,
    // 模型经 EnterPlanMode 切进 Plan：走唯一的档位写入点，不新增写入路径。
    // Goal 处于 active 时 applyRuntimeExecutionState 按既有规则先收口再切档。
    enterPlanMode: async (input) => {
      const previous = readRuntimeExecutionState(runtime);
      const next = await applyRuntimeExecutionState(
        runtime,
        { mode: "plan" },
        {
          source: "tool",
          ...(input?.toolCallId ? { toolCallId: input.toolCallId } : {}),
          ...(input?.traceContext ? { traceContext: input.traceContext } : {}),
        },
      );
      return { mode: next.mode, previousMode: previous.mode };
    },
  };
}
