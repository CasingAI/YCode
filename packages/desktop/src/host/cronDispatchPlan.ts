import type { ModelSelection } from "@zcode/shared";

/**
 * 定时任务派发决策（docs/specs/automation-dispatch-session-trace.md）：
 * 到点必达——保存了具体模型选择的任务在派发解析失败时仍建会话、仍发消息，
 * 以执行域（execution-scope）绑定保存的选择原样发送，轮次失败在会话内呈现。
 *
 * - session-scope：解析成功，沿用现状（会话带解析后模型，sendPrompt 走会话域）。
 * - execution-passthrough：解析失败但存在可直发的具体选择，不回落首选、不写会话配置。
 * - dispatch-reject：组意图（组已删 / 无可用成员）或解析不出 Workspace 首选——
 *   没有可执行域绑定的选择，维持派发失败 + 退避重试 + 卡片原因展示的现状。
 */
export type CronDispatchPlan =
  | { kind: "session-scope"; selection: ModelSelection }
  | { kind: "execution-passthrough"; selection: ModelSelection; resolutionError: string }
  | { kind: "dispatch-reject" };

export function resolveCronDispatchPlan(params: {
  resolutionOk: boolean;
  resolvedSelection?: ModelSelection;
  /** 解析失败的原始错误文本；dispatch-reject 由调用方 rethrow 原始错误对象，不在此传递。 */
  resolutionErrorMessage?: string;
  /** 可执行域直发的保存选择：run 行已固定 > 派发请求快照 > repo 现读。 */
  passthroughSelection?: ModelSelection;
}): CronDispatchPlan {
  if (params.resolutionOk && params.resolvedSelection) {
    return { kind: "session-scope", selection: params.resolvedSelection };
  }
  if (params.passthroughSelection) {
    return {
      kind: "execution-passthrough",
      selection: params.passthroughSelection,
      resolutionError: params.resolutionErrorMessage ?? "unknown",
    };
  }
  return { kind: "dispatch-reject" };
}
