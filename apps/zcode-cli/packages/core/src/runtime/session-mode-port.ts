import type { CollaborationMode, SessionModePort } from "./deps.js";
import type { AgentRuntimeInternal } from "./internal.js";
import { readRuntimeExecutionState } from "./execution-state.js";

export function createRuntimeSessionModePort(runtime: AgentRuntimeInternal): SessionModePort {
  return {
    supportsPermissionFullAccess: () => Boolean(runtime.sessionStore?.commitPermissionFullAccess),
    getMode: () => readRuntimeExecutionState(runtime).mode,
    // 权限轴是单值，两个 isXxxEnabled 只是既有调用点的派生查询。
    isPlanEnabled: () => readRuntimeExecutionState(runtime).mode === "plan",
    isReadOnlyEnabled: () => readRuntimeExecutionState(runtime).mode === "readonly",
  };
}
