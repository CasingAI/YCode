import { submissionModeSchema } from "@zcode/shared/zcode-protocol-v4";

/**
 * 受限档 Goal 门禁——面板候选排除（docs/specs/goal-command-scope-and-decoration.md）。
 *
 * Goal 家族在 Plan / Ask 下必然被 CLI 拒绝：自主循环要落盘，拒绝白名单是 plan/readonly。
 * Agent 与 Bare 放行。档位受限时 `/` 面板不再提供 goal/target 候选。
 *
 * 发送按钮保持可点：拦截与反馈统一在发送时（SessionPane 门禁弹 toast、草稿保留），
 * 桌面 / Web / 手机行为一致，不依赖悬停。曾尝试把按钮按 goalSendBlocked 置灰，
 * 但原生禁用不派发悬停/触摸事件，tooltip 弹不出、点击零反馈，已回退。
 */
export function modeRestrictsGoalCommands(mode: string | undefined | null): boolean {
  const parsed = submissionModeSchema.safeParse(mode);
  return parsed.success && (parsed.data === "plan" || parsed.data === "readonly");
}
