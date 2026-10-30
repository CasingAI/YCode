import assert from "node:assert/strict";
import test from "node:test";
import { resolveAiSearchModelInput } from "../src/command-center/aiSearchModelInput.js";
import type { ComposerRecent } from "../src/lib/composerRecent.js";
import type { ComposerDisplayedModel } from "../src/lib/composerDisplayedModel.js";

// 命令中心 AI 搜索模型输入（docs/specs/composer-displayed-model.md）：
// displayed 整体优先，displayed 的组意图也优先于 recent 的具体模型；缺失才用 recent。

const displayedSelection: ComposerDisplayedModel = {
  selection: { providerId: "p1", modelId: "m-displayed" },
};
const displayedGroup: ComposerDisplayedModel = {
  modelGroupIntent: { groupId: "g1", groupNameSnapshot: "省钱组" },
};
const recentSelection: ComposerRecent = {
  modelSelection: { providerId: "p1", modelId: "m-recent" },
  mode: "yolo",
};
const recentGroup: ComposerRecent = {
  modelGroupIntent: { groupId: "g2", groupNameSnapshot: "备选组" },
  mode: "yolo",
};

test("displayed 具体优先于 recent 具体/组", () => {
  assert.deepEqual(resolveAiSearchModelInput(displayedSelection, recentSelection), {
    selection: displayedSelection.selection,
  });
  assert.deepEqual(resolveAiSearchModelInput(displayedSelection, recentGroup), {
    selection: displayedSelection.selection,
  });
});

test("displayed 组整体优先于 recent 具体", () => {
  assert.deepEqual(resolveAiSearchModelInput(displayedGroup, recentSelection), {
    modelGroupIntent: displayedGroup.modelGroupIntent,
  });
});

test("displayed 缺失时退回 recent 具体，再退回 recent 组", () => {
  assert.deepEqual(resolveAiSearchModelInput(null, recentSelection), {
    selection: recentSelection.modelSelection,
  });
  assert.deepEqual(resolveAiSearchModelInput(undefined, recentGroup), {
    modelGroupIntent: recentGroup.modelGroupIntent,
  });
  assert.deepEqual(resolveAiSearchModelInput(undefined, { mode: "yolo" }), undefined);
});

test("两者都没有时不带 input（沿既有 preferred/CLI 回退）", () => {
  assert.equal(resolveAiSearchModelInput(null, null), undefined);
  assert.equal(resolveAiSearchModelInput(undefined, undefined), undefined);
});

test("组输入只带 modelGroupIntent，不带 selection", () => {
  const input = resolveAiSearchModelInput(displayedGroup, null);
  assert.ok(input);
  assert.equal("selection" in input, false);
  assert.deepEqual(input, { modelGroupIntent: displayedGroup.modelGroupIntent });
});
