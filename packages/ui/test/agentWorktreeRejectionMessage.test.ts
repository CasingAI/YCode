// Agent worktree attach 拒绝码 → i18n 键映射测试（docs/specs/agent-worktree-isolation.md）。
// 词表与 shared agentWorktreeAttachRejectedReasonSchema 对齐；未知码必须回退通用
// 文案键，绝不把 CLI 的英文诊断透给用户。
import assert from "node:assert/strict";
import test from "node:test";
import { agentWorktreeRejectionMessageId } from "../src/v4/agentWorktreeRejection.js";

const PREFIX = "fault.command.agentWorktreeAttachRejected.";

test("maps every stable rejection reason to its i18n key", () => {
  const reasons = [
    "invalid_branch_name",
    "branch_already_exists",
    "not_a_git_repository",
    "worktree_path_conflict",
    "create_failed",
    "session_promoted",
    "session_bound",
  ];
  for (const reason of reasons) {
    assert.equal(
      agentWorktreeRejectionMessageId(`${PREFIX}${reason}`),
      `git.worktreeNotice.rejected.${reason}`,
    );
  }
});

test("falls back to the generic key for unknown or malformed reason codes", () => {
  const unknown = [undefined, null, "", "guard.someOtherGuard", `${PREFIX}not_in_vocabulary`];
  for (const reasonCode of unknown) {
    assert.equal(
      agentWorktreeRejectionMessageId(reasonCode),
      "git.worktreeNotice.rejected.fallback",
    );
  }
});
