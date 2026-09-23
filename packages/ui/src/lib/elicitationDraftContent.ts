// 忽略（decline）会把这次提问判为未回答：草稿只活在组件里，decline 之后没有任何留存路径。
// 因此「草稿里有没有用户写过的东西」是唯一决定要不要二次确认的判据，单独放成纯函数便于
// 单测，避免把产品规则埋在对话框 JSX 里。
export interface ElicitationAnswerDraftLike {
  selectedValues?: readonly string[] | undefined;
  customAnswer?: string | undefined;
}

export function hasElicitationDraftContent(
  drafts: Readonly<Record<string, ElicitationAnswerDraftLike | undefined>>,
): boolean {
  for (const draft of Object.values(drafts)) {
    if (!draft) continue;
    if ((draft.selectedValues?.length ?? 0) > 0) return true;
    if ((draft.customAnswer ?? "").trim().length > 0) return true;
  }
  return false;
}
