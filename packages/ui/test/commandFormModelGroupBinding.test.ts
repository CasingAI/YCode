import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveCommandFormModeBinding,
  resolveCommandFormModelBinding,
  resolveCommandFormThoughtOnModelChange,
} from "../src/settings/commandFormBinding.js";
import { encodeModelGroupSelectValue } from "../src/lib/modelSelectionGroups.js";
import { toOverrideModelGroupIntent } from "../src/settings/ModelOverrideControl.js";

// 命令表单选组→保存→回填（docs/specs/model-group.md）：
// 选组装配出组意图（含组名快照）且 modelTouched，档位跟随清空；
// 未动模型区时装配出 undefined，调用方跳过覆盖写。

const GROUP_VIEW = {
  modelGroups: [{ groupId: "model-group:free", name: "免费组" }],
} as never;

test("选组装配组意图：含当前组名快照，不带具体模型", () => {
  const binding = resolveCommandFormModelBinding({
    normalizedModelValue: encodeModelGroupSelectValue("model-group:free"),
    thoughtLevel: undefined,
    modelSelectionView: GROUP_VIEW,
  });
  assert.deepEqual(binding.modelGroupIntent, {
    groupId: "model-group:free",
    groupNameSnapshot: "免费组",
  });
  assert.equal(binding.modelSelection, undefined);
  assert.equal(binding.modelTouched, true);
});

test("选组跟随档位清空：换组不补默认档", () => {
  assert.equal(
    resolveCommandFormThoughtOnModelChange(
      GROUP_VIEW,
      encodeModelGroupSelectValue("model-group:free"),
    ),
    undefined,
  );
});

test("回填往返：组意图编码→解码→快照一致", () => {
  const intent = toOverrideModelGroupIntent(
    encodeModelGroupSelectValue("model-group:free"),
    GROUP_VIEW,
  );
  assert.deepEqual(intent, { groupId: "model-group:free", groupNameSnapshot: "免费组" });
});

test("编辑未动模型区：装配与 initial 一致且 modelTouched 为 false", () => {
  const initial = {
    modelGroupIntentOverride: { groupId: "model-group:free", groupNameSnapshot: "免费组" },
  } as never;
  const binding = resolveCommandFormModelBinding({
    initial,
    normalizedModelValue: encodeModelGroupSelectValue("model-group:free"),
    thoughtLevel: undefined,
    modelSelectionView: GROUP_VIEW,
  });
  assert.equal(binding.modelTouched, false);
});

test("模式两步语义：编辑未动不碰 mode 键", () => {
  const touched = resolveCommandFormModeBinding({
    initial: { modeOverride: "yolo" } as never,
    modeValue: "inherit",
  });
  assert.equal(touched.mode, undefined);
  assert.equal(touched.modeTouched, true);
  const untouched = resolveCommandFormModeBinding({
    initial: { modeOverride: "yolo" } as never,
    modeValue: "yolo",
  });
  assert.equal(untouched.modeTouched, false);
});
