import type { PendingTurnInput, SubagentForegroundExecutionControl } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ActiveTurnSteeringState } from "../types.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

export function createForegroundGuideControl(
  runtime: AgentRuntimeInternal,
  activeTurn: Pick<ActiveTurnSteeringState, "turnId" | "pendingInputs"> | undefined,
  parent?: SubagentForegroundExecutionControl,
): SubagentForegroundExecutionControl {
  const branch = runtime.branchGeneration;
  const ownerTurnId = activeTurn?.turnId;
  // 关键修复：不要在 child runtime 里再用 runtime.activeTurn 重新找 owner。
  // 工具链透传的是父 owner 的 pendingInputs 对象本身，owner 撤销会同步可见，
  // child 自己的 turn 变化不会覆盖请求归属。
  const inputs = (parent?.observePendingInputs?.() ?? activeTurn?.pendingInputs) as
    | PendingTurnInput[]
    | undefined;
  const isCurrent = () =>
    runtime.branchGeneration === branch && (parent?.isCurrent() ?? true);

  const getLocalGuideIds = () =>
    (inputs ?? [])
      .filter((input) => input.delivery === "guide" || input.intent?.admittedDelivery === "guide")
      .map((input) => input.id);

  const control: SubagentForegroundExecutionControl = {
    executionId: String(ownerTurnId ?? ""),
    epoch: branch ?? 0,
    isCurrent,
    observePendingInputs: () => inputs,
    getYieldRequestIds: () =>
      isCurrent() ? [...(parent?.getYieldRequestIds?.() ?? []), ...getLocalGuideIds()] : [],
    shouldYield: () =>
      isCurrent() && Boolean(parent?.shouldYield?.() || getLocalGuideIds().length > 0),
    // 有父链时优先沿父链注册到父前台执行；无父链的 owner 才写本 runtime。
    registerDependent: (child) => {
      if (parent?.registerDependent) {
        return parent.registerDependent(child);
      }
      const foreground = runtime.activeForegroundExecution;
      const key = `${child.executionId}:${child.epoch}`;
      if (foreground && isCurrent()) {
        foreground.yieldDependents.set(key, child);
        return () => {
          if (foreground.yieldDependents.get(key) === child) {
            foreground.yieldDependents.delete(key);
          }
        };
      }
      return () => {};
    },
  };
  // child 创建即向父链自注册，steer 到达时父前台执行可触达已注册依赖。
  // 归属仍以父输入 owner 为准，fencing 由 isCurrent 保证。
  parent?.registerDependent?.(control);
  return control;
}

export function commitParentGuideYield(state: RegularTurnLoopState): boolean {
  // 只允许模型步骤落库与完整工具批次持久化之后调用；是否仍有效以输入 owner 为准。
  if (state.turnAbortSignal.aborted) return false;
  const control = state.parentForegroundControl;
  if (!control?.isCurrent()) return false;
  if (!(control.shouldYield?.() ?? Boolean(control.getYieldRequestIds?.().length))) return false;
  state.terminationReason = "parent_guide";
  return true;
}
