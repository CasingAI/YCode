// editUserQuery rewind 分支裁决的回归测试（specs/message-history-edit.md 规则 24-26）。
// resolveEditFileRewindExecution 是命令层唯一分支点：
//   - safe/unsafe/ignored 全空 → none（safeFiles=0 直通，等价纯对话编辑，不再 blocked）；
//   - 全部 safe 或「overwrite 且冲突全为 external_modified」→ apply（含 conflictMode 透传）；
//   - ignored 或非可覆盖 unsafe → blocked（竞态兜底语义保留）。
import assert from "node:assert/strict";
import test from "node:test";
// 先引 handlers barrel 再引 fork-edit-retry：executor↔handlers/index 存在生产侧
// 同样存在的模块环，生产入口总是先加载 barrel，测试保持同一初始化顺序。
import "../src/zcode-protocol-v4/commands/handlers/index.js";
import { resolveEditFileRewindExecution } from "../src/zcode-protocol-v4/commands/handlers/fork-edit-retry.js";

function preview(overrides: Record<string, unknown> = {}) {
  return {
    canApply: true,
    safeFiles: [],
    unsafeFiles: [] as Array<{ reason: string }>,
    ignoredFiles: [] as unknown[],
    ...overrides,
  };
}

const safeFile = { action: "restore", operationCount: 1, path: "a.ts", toolNames: ["Write"] };

test("范围内无文件 → none，跳过文件回滚（safeFiles=0 直通）", () => {
  const execution = resolveEditFileRewindExecution(preview(), undefined);
  assert.deepEqual(execution, { action: "none" });
});

test("全部 safe → apply/block，conflictMode 透传为 block", () => {
  const execution = resolveEditFileRewindExecution(
    preview({ safeFiles: [safeFile] }),
    undefined,
  );
  assert.deepEqual(execution, { action: "apply", conflictMode: "block" });
});

test("external_modified + payload overwrite → apply/overwrite", () => {
  const execution = resolveEditFileRewindExecution(
    preview({
      canApply: false,
      unsafeFiles: [{ reason: "external_modified" }],
    }),
    "overwrite",
  );
  assert.deepEqual(execution, { action: "apply", conflictMode: "overwrite" });
});

test("external_modified 但 payload 缺省 block → blocked/UnsafeFiles（覆盖只能来自显式弹窗选择）", () => {
  const execution = resolveEditFileRewindExecution(
    preview({
      canApply: false,
      unsafeFiles: [{ reason: "external_modified" }],
    }),
    undefined,
  );
  assert.deepEqual(execution, {
    action: "blocked",
    reasonCode: "guard.workspaceRewindUnsafeFiles",
  });
});

test("存在 ignored（bash 变更）→ blocked/IgnoredFiles，即使选择 overwrite", () => {
  const execution = resolveEditFileRewindExecution(
    preview({
      canApply: false,
      unsafeFiles: [{ reason: "external_modified" }],
      ignoredFiles: [{ operationCount: 1, path: "c.ts", reason: "bash_ignored" }],
    }),
    "overwrite",
  );
  assert.deepEqual(execution, {
    action: "blocked",
    reasonCode: "guard.workspaceRewindIgnoredFiles",
  });
});

test("checkpoint_missing 等数据缺失类 → blocked/UnsafeFiles，overwrite 不可越过", () => {
  const execution = resolveEditFileRewindExecution(
    preview({
      canApply: false,
      unsafeFiles: [{ reason: "checkpoint_missing" }],
    }),
    "overwrite",
  );
  assert.deepEqual(execution, {
    action: "blocked",
    reasonCode: "guard.workspaceRewindUnsafeFiles",
  });
});
