// 编辑重发文件回滚弹窗三态决策的回归测试（specs/message-history-edit.md 规则 23-26）。
import assert from "node:assert/strict";
import test from "node:test";
import type { V4ConversationFileRewindPreviewResult } from "@zcode/shared/zcode-protocol-v4";
import { resolveEditFileRewindDialogDecision, resolveUndoWorkspaceMode } from "../src/v4/conversationEditFileRewindDialog.js";

function preview(overrides: Partial<V4ConversationFileRewindPreviewResult> = {}) {
  return {
    canApply: true,
    safeFiles: [],
    unsafeFiles: [],
    ignoredFiles: [],
    ...overrides,
  } as V4ConversationFileRewindPreviewResult;
}

test("范围内无文件 → 纯对话 Undo 弹窗", () => {
  const decision = resolveEditFileRewindDialogDecision(preview());
  assert.equal(decision.variant, "conversationOnly");
});

test("全部 safe → 文件清单双动作形态，无覆盖", () => {
  const decision = resolveEditFileRewindDialogDecision(
    preview({
      safeFiles: [{ action: "restore", operationCount: 2, path: "a.ts", toolNames: ["Write"] }],
    }),
  );
  assert.equal(decision.variant, "withFiles");
});

test("存在 external_modified → 冲突形态且允许覆盖", () => {
  const decision = resolveEditFileRewindDialogDecision(
    preview({
      safeFiles: [{ action: "restore", operationCount: 1, path: "a.ts", toolNames: ["Write"] }],
      unsafeFiles: [
        { operationCount: 1, path: "b.ts", reason: "external_modified", toolNames: ["Write"] },
      ],
    }),
  );
  assert.deepEqual(
    decision.variant === "conflict" ? decision.allowOverwrite : null,
    true,
    "仅 external_modified 冲突时必须允许「仍然恢复文件并重发」",
  );
});

test("存在 bash_ignored → 冲突形态且禁止覆盖", () => {
  const decision = resolveEditFileRewindDialogDecision(
    preview({
      unsafeFiles: [
        { operationCount: 1, path: "b.ts", reason: "external_modified", toolNames: ["Write"] },
      ],
      ignoredFiles: [
        { operationCount: 1, path: "c.ts", reason: "bash_ignored", toolNames: ["Bash"] },
      ],
    }),
  );
  assert.equal(decision.variant, "conflict");
  assert.equal(decision.variant === "conflict" ? decision.allowOverwrite : null, false);
});

test("checkpoint_missing 等数据缺失类冲突 → 冲突形态且禁止覆盖", () => {
  const decision = resolveEditFileRewindDialogDecision(
    preview({
      unsafeFiles: [
        { operationCount: 1, path: "b.ts", reason: "checkpoint_missing", toolNames: ["Write"] },
      ],
    }),
  );
  assert.equal(decision.variant, "conflict");
  assert.equal(decision.variant === "conflict" ? decision.allowOverwrite : null, false);
});

// 撤销确认 Checkbox → 提交模式映射（specs/conversation-edit-undo-confirm.md 规则 3、7）。
test("勾选同时恢复文件 → rewind 提交", () => {
  assert.equal(resolveUndoWorkspaceMode(true), "rewind");
});

test("默认不勾选 → preserve 提交（不动文件）", () => {
  assert.equal(resolveUndoWorkspaceMode(false), "preserve");
});
