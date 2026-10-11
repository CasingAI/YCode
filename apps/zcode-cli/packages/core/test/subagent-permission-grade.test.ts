import assert from "node:assert/strict";
import test from "node:test";
import {
  isReadOnlyPermissionParent,
  resolveSubagentPermissionMode,
} from "../src/runtime/methods/subagent.js";

function wouldDenySpawn(
  parentMode: "plan" | "readonly" | "yolo" | "bare" | undefined,
  permissionMode: "auto" | "plan" | "readonly" | "yolo" | undefined,
  builtInExplore: boolean,
): boolean {
  const childMode = resolveSubagentPermissionMode(parentMode, permissionMode, builtInExplore);
  return isReadOnlyPermissionParent(parentMode) && childMode === "yolo";
}

test("Explore 未写 permissionMode 时解析为 Ask，任意父都放行", () => {
  assert.equal(resolveSubagentPermissionMode("readonly", undefined, true), "readonly");
  assert.equal(resolveSubagentPermissionMode("plan", undefined, true), "readonly");
  assert.equal(resolveSubagentPermissionMode("yolo", undefined, true), "readonly");
  assert.equal(resolveSubagentPermissionMode("bare", undefined, true), "readonly");
  assert.equal(wouldDenySpawn("readonly", undefined, true), false);
  assert.equal(wouldDenySpawn("plan", undefined, true), false);
});

test("通用子未写 permissionMode 时解析为 Agent", () => {
  assert.equal(resolveSubagentPermissionMode("readonly", undefined, false), "yolo");
  assert.equal(resolveSubagentPermissionMode("bare", undefined, false), "yolo");
  assert.equal(resolveSubagentPermissionMode("yolo", "auto", false), "yolo");
  assert.equal(resolveSubagentPermissionMode("yolo", "plan", false), "yolo");
});

test("Ask / Plan 父派出完全访问子必须拒绝，不压档", () => {
  assert.equal(wouldDenySpawn("readonly", undefined, false), true);
  assert.equal(wouldDenySpawn("plan", "yolo", false), true);
  assert.equal(wouldDenySpawn("readonly", "auto", false), true);
  // 解析结果仍是 yolo：拒绝发生在派出，不得改写成 readonly 再跑。
  assert.equal(resolveSubagentPermissionMode("readonly", "yolo", false), "yolo");
});

test("Ask / Plan 父派出 Ask 子放行", () => {
  assert.equal(wouldDenySpawn("readonly", "readonly", false), false);
  assert.equal(wouldDenySpawn("plan", "readonly", false), false);
});

test("Agent / Bare 父可派 Ask 或 Agent 子", () => {
  assert.equal(wouldDenySpawn("yolo", undefined, false), false);
  assert.equal(wouldDenySpawn("bare", undefined, false), false);
  assert.equal(wouldDenySpawn("yolo", "readonly", false), false);
  assert.equal(wouldDenySpawn("bare", "readonly", false), false);
  assert.equal(isReadOnlyPermissionParent("bare"), false);
  assert.equal(isReadOnlyPermissionParent("yolo"), false);
});
