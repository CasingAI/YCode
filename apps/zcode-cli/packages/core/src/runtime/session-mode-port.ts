import type { CollaborationMode, SessionModePort } from "./deps.js";
import type { AgentRuntimeInternal } from "./internal.js";
import { applyRuntimeExecutionState, readRuntimeExecutionState } from "./execution-state.js";

export function createRuntimeSessionModePort(runtime: AgentRuntimeInternal): SessionModePort {
  return {
    supportsPermissionFullAccess: () => Boolean(runtime.sessionStore?.commitPermissionFullAccess),
    getMode: () => readRuntimeExecutionState(runtime).mode,
    getPrePlanMode: () => runtime.config.prePlanMode,
    // 权限轴是单值，两个 isXxxEnabled 只是既有调用点的派生查询。
    isPlanEnabled: () => readRuntimeExecutionState(runtime).mode === "plan",
    isReadOnlyEnabled: () => readRuntimeExecutionState(runtime).mode === "readonly",
    async enterPlanMode(input) {
      const previous = readRuntimeExecutionState(runtime);
      const next = await applyRuntimeExecutionState(
        runtime,
        { mode: "plan" },
        { ...input, source: "tool" },
      );
      return { mode: next.mode, previousMode: previous.mode };
    },
    async exitPlanMode(input) {
      const previous = readRuntimeExecutionState(runtime);
      if (previous.mode !== "plan") {
        throw new Error(
          "You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.",
        );
      }

      // 返回档在 apply 里会被清掉，先取出来；显式切进计划模式的会话没有记录，回落到完全访问。
      const returnMode = runtime.config.prePlanMode ?? "yolo";
      const next = await applyRuntimeExecutionState(
        runtime,
        { mode: returnMode },
        { ...input, source: "tool" },
      );
      return {
        mode: next.mode as Exclude<CollaborationMode, "plan">,
        previousMode: previous.mode,
      };
    },
  };
}
