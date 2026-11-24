import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import {
  submissionModeSchema,
  type SessionConfigState,
} from "@zcode/shared/zcode-protocol-v4";

/** 新工具结果直接设置标记；仅去重已处理结果，不保护期间的手动改选。 */
export function applyComposerPlanTransition(
  draft: V4ComposerDraft,
  transition: SessionConfigState["planTransition"],
  authoritativeMode: string | undefined,
): V4ComposerDraft {
  if (!transition || draft.lastPlanTransitionId === transition.toolCallId) return draft;
  // planTransition 是单次工具切档回执，不是历史流水：只有回执方向与同一份快照的
  // 权威 mode 一致才消费。非工具来源（提交载荷、显式切档、全访问授权）把会话切离
  // Plan 后，快照可能残留旧的「进入 Plan」回执；桌面端早已消费过该 ID，而外部版
  // （Web / 手机远控）有独立 localStorage，没有这条去重记录，会把历史回执当成新
  // 事件把输入框拉回 Plan（docs/specs/agent-mode-axis.md）。方向冲突或权威档缺失/
  // 非法时保持草稿不动，且不推进去重 ID，等权威投影重新播种。
  if (authoritativeMode === undefined) return draft;
  const mode = submissionModeSchema.safeParse(authoritativeMode);
  if (!mode.success) return draft;
  if (transition.planEnabled !== (mode.data === "plan")) return draft;
  const next: V4ComposerDraft = {
    ...draft,
    lastPlanTransitionId: transition.toolCallId,
  };
  if (transition.planEnabled) {
    next.mode = "plan";
    return next;
  }
  // 退出计划模式时不猜回落档位：清掉 mode 让草稿按 Session 权威投影重新播种。
  // 猜错会把「进入计划模式前的只读档」提交成完全访问（提权）。
  delete next.mode;
  return next;
}
