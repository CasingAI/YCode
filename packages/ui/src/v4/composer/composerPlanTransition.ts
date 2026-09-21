import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";

/** 新工具结果直接设置标记；仅去重已处理结果，不保护期间的手动改选。 */
export function applyComposerPlanTransition(
  draft: V4ComposerDraft,
  transition: SessionConfigState["planTransition"],
): V4ComposerDraft {
  if (!transition || draft.lastPlanTransitionId === transition.toolCallId) return draft;
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
