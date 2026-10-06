// Agent worktree attach 拒绝码 → i18n 键映射（docs/specs/agent-worktree-isolation.md）。
// 纯函数独立成文件：SessionPane 与测试共用，不把组件树拖进单测 import 链。
// 词表与 shared agentWorktreeAttachRejectedReasonSchema 对齐；未知 reasonCode
//（旧 CLI / 未知失败）回退通用文案键，不把英文 stderr 透给用户。
const AGENT_WORKTREE_REJECTED_MESSAGE_IDS = new Set([
  "invalid_branch_name",
  "branch_already_exists",
  "not_a_git_repository",
  "worktree_path_conflict",
  "create_failed",
  "session_promoted",
  "session_bound",
]);
const AGENT_WORKTREE_REJECTED_FAULT_PREFIX = "fault.command.agentWorktreeAttachRejected.";

export function agentWorktreeRejectionMessageId(reasonCode: string | undefined | null): string {
  if (reasonCode?.startsWith(AGENT_WORKTREE_REJECTED_FAULT_PREFIX)) {
    const reason = reasonCode.slice(AGENT_WORKTREE_REJECTED_FAULT_PREFIX.length);
    if (AGENT_WORKTREE_REJECTED_MESSAGE_IDS.has(reason)) {
      return `git.worktreeNotice.rejected.${reason}`;
    }
  }
  return "git.worktreeNotice.rejected.fallback";
}
