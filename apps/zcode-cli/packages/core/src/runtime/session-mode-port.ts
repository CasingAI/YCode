import type { SessionModePort } from "./deps.js";
import type { AgentRuntimeInternal } from "./internal.js";
import { applyRuntimeExecutionState, readRuntimeExecutionState } from "./execution-state.js";

export function createRuntimeSessionModePort(runtime: AgentRuntimeInternal): SessionModePort {
  return {
    supportsPermissionFullAccess: () => Boolean(runtime.sessionStore?.commitPermissionFullAccess),
    getMode: () => readRuntimeExecutionState(runtime).mode,
    // 权限轴是单值，两个 isXxxEnabled 只是既有调用点的派生查询。
    isPlanEnabled: () => readRuntimeExecutionState(runtime).mode === "plan",
    isReadOnlyEnabled: () => readRuntimeExecutionState(runtime).mode === "readonly",
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
