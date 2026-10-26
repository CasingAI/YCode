import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildModelGroupSelectGroups,
  buildSettingsFormModelSelectGroups,
  decodeModelGroupSelectValue,
  encodeModelGroupSelectValue,
  withModelGroupSection,
} from "../src/lib/modelSelectionGroups.js";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

// 模型组分节（docs/specs/model-group.md）：唯一拼装入口 withModelGroupSection。
// 条目值编码 model-group:<groupId>，与 provider/model 编码分开命名空间。

test("成员档位添加后固定：成员行只读展示，不提供改值入口", () => {
  const section = read("../src/settings/ModelGroupsSection.tsx");
  // 成员行不再有档位下拉，也没有把档位写回成员列表的 onValueChange。
  assert.doesNotMatch(section, /model-group-member-thought-/);
  assert.doesNotMatch(section, /reasoningLevel: value/);
  const badge = read("../src/settings/ModelGroupMemberThoughtLevel.tsx");
  assert.match(badge, /candidate\.reasoningLevels\.includes\(level\)/);
  assert.match(badge, /id: "settings\.modelGroups\.unboundThoughtLevel"/);
  assert.match(badge, /id: "settings\.modelGroups\.unsupportedThoughtLevel"/);
  assert.match(badge, /id: "settings\.modelGroups\.memberThoughtLevelFixed"/);
});

test("添加成员候选不排除组内已有模型：同一模型可重复加入", () => {
  const section = read("../src/settings/ModelGroupsSection.tsx");
  // 候选列表直接来自全部成员候选，不再按 provider+model 过滤组内成员。
  assert.doesNotMatch(section, /selectedMembers\.some\(/);
  assert.match(section, /const addableCandidates = memberCandidates;/);
});

test("添加成员在同一弹窗选择模型与档位，并保留隐藏及不可用候选", () => {
  const dialog = read("../src/settings/ModelGroupMemberPickerDialog.tsx");
  assert.match(dialog, /<ModelConfigSelect[\s\S]*?onValueChange=\{handleModelChange\}/);
  assert.match(dialog, /<ThoughtLevelCycleControl[\s\S]*?onValueChange=\{setReasoningLevel\}/);
  assert.match(dialog, /setReasoningLevel\(candidate\?\.defaultReasoningLevel\)/);
  assert.match(dialog, /!selectedCandidate\.reasoningLevels\.includes\(reasoningLevel\)/);
  assert.match(
    dialog,
    /selectedCandidate\.reasoningLevels\.includes\([\s\S]*?\)\s*\?\s*reasoningLevel\s*:\s*selectedCandidate\.defaultReasoningLevel/,
  );
  assert.match(dialog, /isItemLocked=\{MODEL_ITEM_NEVER_LOCKED\}/);
  assert.match(dialog, /memberUnavailableHint/);
  assert.match(dialog, /providerHidden[\s\S]*?memberHidden/);
  assert.match(
    dialog,
    /\.\.\.\(thoughtOption && confirmedReasoningLevel[\s\S]*?\{ reasoningLevel: confirmedReasoningLevel \}/,
  );
});

test("组值编解码：前后缀 round-trip，空组 ID 拒绝", () => {
  assert.equal(encodeModelGroupSelectValue("g1"), "model-group:g1");
  assert.equal(decodeModelGroupSelectValue("model-group:g1"), "g1");
  assert.equal(decodeModelGroupSelectValue("custom:glm:m"), null);
  assert.equal(decodeModelGroupSelectValue("model-group:"), null);
  assert.equal(decodeModelGroupSelectValue("model-group:  "), null);
});

test("无组时原样返回 registry 分组", () => {
  const registry = [{ key: "r1", label: "P", items: [] }];
  assert.deepEqual(
    withModelGroupSection({ registryGroups: registry, view: null, groupSectionLabel: "模型组" }),
    registry,
  );
  assert.deepEqual(
    withModelGroupSection({
      registryGroups: registry,
      view: { modelGroups: [], modelGroupsPrimary: false },
      groupSectionLabel: "模型组",
    }),
    registry,
  );
});

test("非 Primary：组收进二级「模型组」菜单，拼在 registry 之后", () => {
  const registry = [{ key: "r1", label: "P", items: [] }];
  const view = {
    modelGroups: [
      { groupId: "g1", name: "组一", members: [], enabled: true },
      { groupId: "g2", name: "组二", members: [], enabled: true },
    ],
    modelGroupsPrimary: false,
  };
  const groups = withModelGroupSection({
    registryGroups: registry,
    view: view as never,
    groupSectionLabel: "模型组",
  });
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.key, "r1");
  const section = groups[1]!;
  assert.equal(section.key, "model-groups");
  assert.equal(section.label, "模型组");
  assert.deepEqual(
    section.items.map((item) => item.value),
    ["model-group:g1", "model-group:g2"],
  );
  assert.deepEqual(
    section.items.map((item) => item.name),
    ["组一", "组二"],
  );
});

test("Primary 单组：置顶为一个本地化「模型组」分节，组名只出现一次", () => {
  const registry = [{ key: "r1", label: "P", items: [] }];
  const view = {
    modelGroups: [{ groupId: "g1", name: "组一", members: [], enabled: true }],
    modelGroupsPrimary: true,
  };
  const groups = withModelGroupSection({
    registryGroups: registry,
    view: view as never,
    groupSectionLabel: "Model groups",
  });
  assert.equal(groups.length, 2);
  const section = groups[0]!;
  assert.equal(section.key, "model-groups");
  assert.equal(section.label, "Model groups");
  assert.equal(section.directItems, true);
  assert.deepEqual(section.items, [
    { key: "model-group:g1", value: "model-group:g1", name: "组一" },
  ]);
  assert.equal(groups[1]?.key, "r1");
});

test("Primary 多组：同一分节内平铺，顺序不变且不产生逐组直接分组", () => {
  const registry = [{ key: "r1", label: "P", items: [] }];
  const view = {
    modelGroups: [
      { groupId: "g1", name: "组一", members: [], enabled: true },
      { groupId: "g2", name: "组二", members: [], enabled: true },
    ],
    modelGroupsPrimary: true,
  };
  const groups = withModelGroupSection({
    registryGroups: registry,
    view: view as never,
    groupSectionLabel: "模型组",
  });
  assert.equal(groups.length, 2);
  const section = groups[0]!;
  assert.equal(section.key, "model-groups");
  assert.equal(section.label, "模型组");
  assert.equal(section.directItems, true);
  assert.deepEqual(
    section.items.map((item) => item.value),
    ["model-group:g1", "model-group:g2"],
  );
  assert.deepEqual(
    section.items.map((item) => item.name),
    ["组一", "组二"],
  );
  // 只有分节本身是 Primary 平铺；组名不再各自成为一级分组标题。
  assert.deepEqual(
    groups.filter((group) => group.directItems === true).map((group) => group.key),
    ["model-groups"],
  );
  assert.deepEqual(
    groups.map((group) => group.label),
    ["模型组", "P"],
  );
});

test("Primary 无模型组：不渲染空的「模型组」分节", () => {
  const registry = [{ key: "r1", label: "P", items: [] }];
  assert.deepEqual(
    withModelGroupSection({
      registryGroups: registry,
      view: { modelGroups: [], modelGroupsPrimary: true },
      groupSectionLabel: "模型组",
    }),
    registry,
  );
});

test("buildModelGroupSelectGroups：纯展示投影，每组一条条目，值编码一致", () => {
  const groups = buildModelGroupSelectGroups({
    modelGroups: [{ groupId: "g9", name: "九组", members: [], enabled: true }],
  } as never);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.items.length, 1);
  assert.equal(groups[0]?.items[0]?.value, "model-group:g9");
  assert.equal(groups[0]?.items[0]?.name, "九组");
});

test("sectionPrimary 覆盖：优先于 view.modelGroupsPrimary，选择值与顺序不变", () => {
  const registry = [{ key: "r1", label: "P", items: [] }];
  const groupsView = {
    modelGroups: [
      { groupId: "g1", name: "组一", members: [], enabled: true },
      { groupId: "g2", name: "组二", members: [], enabled: true },
    ],
  };
  const values = ["model-group:g1", "model-group:g2"];

  // 视图非 Primary，但调用方显式要求置顶：仍只组装一个分节。
  const forcedPrimary = withModelGroupSection({
    registryGroups: registry,
    view: { ...groupsView, modelGroupsPrimary: false },
    groupSectionLabel: "模型组",
    sectionPrimary: true,
  });
  assert.equal(forcedPrimary.length, 2);
  assert.equal(forcedPrimary[0]?.key, "model-groups");
  assert.equal(forcedPrimary[0]?.directItems, true);
  assert.deepEqual(
    forcedPrimary[0]?.items.map((item) => item.value),
    values,
  );

  // 视图 Primary，但设置表单显式要求收进二级菜单：结构保持原状。
  const forcedSecondary = withModelGroupSection({
    registryGroups: registry,
    view: { ...groupsView, modelGroupsPrimary: true },
    groupSectionLabel: "模型组",
    sectionPrimary: false,
  });
  assert.equal(forcedSecondary.length, 2);
  assert.equal(forcedSecondary[0]?.key, "r1");
  assert.equal(forcedSecondary[1]?.key, "model-groups");
  assert.equal(forcedSecondary[1]?.label, "模型组");
  assert.equal(forcedSecondary[1]?.directItems, undefined);
  assert.deepEqual(
    forcedSecondary[1]?.items.map((item) => item.value),
    values,
  );
});

test("buildSettingsFormModelSelectGroups：表单共用入口，组收进二级菜单", () => {
  // 表单侧与 Composer 共用同一套拼装，组恒收进二级，不置顶。
  const view = {
    revision: 1,
    providers: [
      {
        providerId: "p1",
        providerName: "P",
        templateId: undefined,
        config: {
          api: { type: "anthropic-messages", baseUrl: "https://api.example.com" },
        },
        models: [{ modelId: "m", config: { properties: { inputFormat: {} } } }],
      },
    ],
    modelGroups: [{ groupId: "g1", name: "组一", members: [], enabled: true }],
    modelGroupsPrimary: false,
  } as never;
  const groups = buildSettingsFormModelSelectGroups("glm" as never, view, (id: string) => id);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.key, "registry-provider:p1");
  assert.equal(groups[1]?.key, "model-groups");
  assert.deepEqual(
    groups[1]?.items.map((item) => item.value),
    ["model-group:g1"],
  );
});
