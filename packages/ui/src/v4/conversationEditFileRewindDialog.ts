import type { V4ConversationFileRewindPreviewResult } from "@zcode/shared/zcode-protocol-v4";

/**
 * 编辑重发的文件回滚弹窗三态决策（specs/message-history-edit.md 规则 23-26）。
 * 纯函数便于测试；调用方是编辑卡的 rewind 提交链（ConversationRowView）。
 */
export type EditFileRewindDialogDecision =
  // 编辑点之后没有 checkpoint 级文件：只弹对话 Undo 确认，不提文件。
  | { variant: "conversationOnly" }
  // 全部文件都可安全恢复：文件清单 + 双动作（含文件恢复 / 不动文件）。
  | { variant: "withFiles"; preview: V4ConversationFileRewindPreviewResult }
  // 有 unsafe/ignored 冲突：说明原因 + 三选（仅对话 / 覆盖恢复 / 取消）。
  | {
      variant: "conflict";
      preview: V4ConversationFileRewindPreviewResult;
      /** 仅全部冲突都是 external_modified 时允许「仍然恢复文件并重发」。 */
      allowOverwrite: boolean;
    };

/**
 * 按 preview 三分类映射弹窗形态：文件口径 = safe + unsafe + ignored 并集
 * （specs/message-history-edit.md 规则 27）。ignored（bash_ignored）无法恢复，
 * 存在即降级为冲突形态，让用户知情后选择。
 */
export function resolveEditFileRewindDialogDecision(
  preview: V4ConversationFileRewindPreviewResult,
): EditFileRewindDialogDecision {
  const involvedFileCount =
    preview.safeFiles.length + preview.unsafeFiles.length + preview.ignoredFiles.length;
  if (involvedFileCount === 0) {
    return { variant: "conversationOnly" };
  }
  if (preview.unsafeFiles.length === 0 && preview.ignoredFiles.length === 0) {
    return { variant: "withFiles", preview };
  }
  const allowOverwrite =
    preview.ignoredFiles.length === 0 &&
    preview.unsafeFiles.length > 0 &&
    preview.unsafeFiles.every((file) => file.reason === "external_modified");
  return { variant: "conflict", preview, allowOverwrite };
}

/**
 * 撤销确认通用框 Checkbox → 提交 workspaceMode 映射
 *（specs/conversation-edit-undo-confirm.md 规则 3、7）：
 * 勾选「同时恢复文件」= rewind，未勾选（默认）= preserve。
 */
export function resolveUndoWorkspaceMode(restoreChecked: boolean): "rewind" | "preserve" {
  return restoreChecked ? "rewind" : "preserve";
}
