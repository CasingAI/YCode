import assert from "node:assert/strict";
import test from "node:test";
import type { ModelGroupIntent, ModelSelection, ZCodeSlashCommand } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import {
  findCommandModelBinding,
  findCommandModelGroupBinding,
  isCommandBindingGroupAvailable,
  resolveCommandGroupBindingRestore,
  resolveCommandMentionPaint,
  shouldDeclareCommandBindingExecution,
} from "../src/v4/composer/commandBindingPaint.js";

// 命令组绑定着色（docs/specs/model-group.md）：组与具体模型互斥，组优先；
// 绑定组已删/停用时芯片置不可用并提示，不静默切换；发送侧 execution 按组比较。

const GROUP: ModelGroupIntent = { groupId: "model-group:free", groupNameSnapshot: "免费组" };
const BEFORE: ModelSelection = {
  providerId: "zcode",
  modelId: "glm-5.3",
  options: { reasoningLevel: "high" },
};

function viewWithGroup(groupIds: readonly string[]): ModelSelectionView {
  return {
    revision: 1,
    providers: [],
    modelGroups: groupIds.map((groupId) => ({ groupId, name: groupId })),
  } as unknown as ModelSelectionView;
}

function groupCatalog(overrides: Partial<ZCodeSlashCommand> = {}): ZCodeSlashCommand[] {
  return [
    {
      name: "compact",
      description: "compact",
      inputHint: "/compact",
      source: "builtin",
      modelGroupIntentOverride: GROUP,
      ...overrides,
    },
  ] as unknown as ZCodeSlashCommand[];
}

test("目录查组绑定：组与具体模型互斥，组优先", () => {
  assert.deepEqual(findCommandModelGroupBinding(groupCatalog(), "/Compact"), GROUP);
  assert.equal(findCommandModelGroupBinding(groupCatalog(), "goal"), undefined);
  // 有组时具体模型绑定为空，发送侧不撞协议互斥校验。
  assert.equal(findCommandModelBinding(groupCatalog(), "compact"), undefined);
});

test("组可用性：组不在当前视图时判定为不可用", () => {
  assert.equal(isCommandBindingGroupAvailable(viewWithGroup(["model-group:free"]), GROUP), true);
  assert.equal(isCommandBindingGroupAvailable(viewWithGroup(["model-group:other"]), GROUP), false);
  assert.equal(isCommandBindingGroupAvailable(null, GROUP), false);
});

test("插入组芯片：写组意图并快照进入前的选择", () => {
  const decision = resolveCommandMentionPaint({
    commandName: "compact",
    slashCommands: groupCatalog(),
    draft: { modelSelection: BEFORE },
    modelSelectionView: viewWithGroup(["model-group:free"]),
  });
  assert.deepEqual(decision, {
    kind: "paint",
    paint: { name: "compact", groupBinding: GROUP },
    selection: undefined,
    groupIntent: GROUP,
    mode: undefined,
  });
});

test("组不可用：不切换也不快照", () => {
  const decision = resolveCommandMentionPaint({
    commandName: "compact",
    slashCommands: groupCatalog(),
    draft: { modelSelection: BEFORE },
    modelSelectionView: viewWithGroup(["model-group:other"]),
  });
  assert.deepEqual(decision, { kind: "unavailable" });
});

test("删组芯片：回到进入前的选择与组快照", () => {
  const decision = resolveCommandMentionPaint({
    commandName: null,
    slashCommands: groupCatalog(),
    draft: {
      modelSelection: BEFORE,
      modelGroupIntent: GROUP,
      commandBinding: { name: "compact", groupBinding: GROUP },
    },
    modelSelectionView: viewWithGroup(["model-group:free"]),
  });
  assert.deepEqual(decision, {
    kind: "restore",
    selection: BEFORE,
    groupIntent: undefined,
    mode: undefined,
  });
});

test("组复原目标：没有着色时等于当前组意图", () => {
  assert.deepEqual(resolveCommandGroupBindingRestore({ modelGroupIntent: GROUP }), GROUP);
  assert.equal(resolveCommandGroupBindingRestore({}), undefined);
});

test("仅本轮声明：组仍等于绑定默认才声明", () => {
  assert.equal(
    shouldDeclareCommandBindingExecution(
      { modelGroupIntent: GROUP, commandBinding: { name: "compact", groupBinding: GROUP } },
      undefined,
      GROUP,
    ),
    true,
  );
  const other: ModelGroupIntent = { groupId: "model-group:other", groupNameSnapshot: "其它" };
  assert.equal(
    shouldDeclareCommandBindingExecution(
      { modelGroupIntent: other, commandBinding: { name: "compact", groupBinding: GROUP } },
      undefined,
      other,
    ),
    false,
  );
});
