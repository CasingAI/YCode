import assert from "node:assert/strict";
import test from "node:test";
import type { V4ComposerDraft } from "../src/v4/composer/composerDraftStore.js";
import { applyComposerPlanTransition } from "../src/v4/composer/composerPlanTransition.js";

// planTransition 是一次工具切档回执，不是可重放的历史流水（docs/specs/agent-mode-axis.md）：
// 只有回执方向与同一份快照的权威 config.mode === "plan" 一致时才允许改草稿。
// 外部版（Web / 手机远控）有独立 localStorage，没有桌面端消费过的去重 ID；
// 不校验方向时，快照残留的旧「进入 Plan」回执会把输入框拉回 Plan 并带进下一次提交。

const baseDraft = (): V4ComposerDraft => ({ text: "", updatedAt: 0 });
const enterPlan = { toolCallId: "tool-enter-1", planEnabled: true };
const exitPlan = { toolCallId: "tool-exit-1", planEnabled: false };

test("权威档为 plan 且回执为进入方向：草稿切到 plan 并记录去重 ID", () => {
  const next = applyComposerPlanTransition(baseDraft(), enterPlan, "plan");
  assert.equal(next.mode, "plan");
  assert.equal(next.lastPlanTransitionId, "tool-enter-1");
});

test("权威档为 plan 且草稿已有其他档：进入回执仍按工具意图覆盖", () => {
  const draft: V4ComposerDraft = { ...baseDraft(), mode: "yolo" };
  const next = applyComposerPlanTransition(draft, enterPlan, "plan");
  assert.equal(next.mode, "plan");
  assert.equal(next.lastPlanTransitionId, "tool-enter-1");
});

test("权威档已非 plan 但残留进入回执：草稿保持不动，不推进去重 ID", () => {
  const draft: V4ComposerDraft = { ...baseDraft(), mode: "yolo" };
  const next = applyComposerPlanTransition(draft, enterPlan, "yolo");
  // 原样返回：不改 mode、不写 lastPlanTransitionId，等权威投影重新播种。
  assert.equal(next, draft);
  assert.equal(next.mode, "yolo");
  assert.equal(next.lastPlanTransitionId, undefined);
});

test("权威档为 team 但残留进入回执：草稿保持不动", () => {
  const draft: V4ComposerDraft = { ...baseDraft(), mode: "team" };
  const next = applyComposerPlanTransition(draft, enterPlan, "team");
  assert.equal(next, draft);
  assert.equal(next.mode, "team");
});

test("权威档为 plan 但残留退出回执：草稿保持不动", () => {
  const draft: V4ComposerDraft = { ...baseDraft(), mode: "plan" };
  const next = applyComposerPlanTransition(draft, exitPlan, "plan");
  assert.equal(next, draft);
  assert.equal(next.mode, "plan");
  assert.equal(next.lastPlanTransitionId, undefined);
});

test("权威档为 yolo 且回执为退出方向：删除草稿 mode 等待重新播种", () => {
  const draft: V4ComposerDraft = { ...baseDraft(), mode: "plan" };
  const next = applyComposerPlanTransition(draft, exitPlan, "yolo");
  assert.equal(next.mode, undefined);
  assert.equal(next.lastPlanTransitionId, "tool-exit-1");
});

test("权威档为 readonly 且回执为退出方向：同样删除草稿 mode", () => {
  const draft: V4ComposerDraft = { ...baseDraft(), mode: "plan" };
  const next = applyComposerPlanTransition(draft, exitPlan, "readonly");
  assert.equal(next.mode, undefined);
  assert.equal(next.lastPlanTransitionId, "tool-exit-1");
});

test("权威档缺失：草稿保持不动，不得把缺失当成已退出 Plan", () => {
  const draft: V4ComposerDraft = { ...baseDraft(), mode: "yolo" };
  const next = applyComposerPlanTransition(draft, enterPlan, undefined);
  assert.equal(next, draft);
  assert.equal(next.mode, "yolo");
});

test("权威档为协议外旧值：草稿保持不动", () => {
  const draft: V4ComposerDraft = { ...baseDraft(), mode: "yolo" };
  const next = applyComposerPlanTransition(draft, enterPlan, "build");
  assert.equal(next, draft);
  assert.equal(next.mode, "yolo");
});

test("同一回执已消费过：按去重跳过", () => {
  const draft: V4ComposerDraft = {
    ...baseDraft(),
    mode: "yolo",
    lastPlanTransitionId: "tool-enter-1",
  };
  const next = applyComposerPlanTransition(draft, enterPlan, "plan");
  assert.equal(next, draft);
  assert.equal(next.mode, "yolo");
});

test("无回执：草稿保持不动", () => {
  const draft = baseDraft();
  const next = applyComposerPlanTransition(draft, undefined, "plan");
  assert.equal(next, draft);
});
