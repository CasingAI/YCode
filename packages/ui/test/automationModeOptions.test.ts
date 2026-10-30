import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOMATION_DEFAULT_MODE,
  AUTOMATION_MODE_VALUES,
  buildAutomationModeOption,
  resolveAutomationModeValue,
  shouldSubmitAutomationMode,
} from "../src/settings/automationAgentConfigOptions.js";

test("自动化档位只保留 Agent / Team，新建默认 Agent", () => {
  assert.equal(AUTOMATION_DEFAULT_MODE, "yolo");
  assert.deepEqual([...AUTOMATION_MODE_VALUES], ["yolo", "team"]);
});

test("历史空值与旧档位仅回退展示，Team 与旧 bare 保留 Team", () => {
  for (const value of [
    undefined,
    null,
    "",
    "plan",
    "readonly",
    "build",
    "edit",
    "auto",
    "autoEdit",
  ]) {
    assert.equal(resolveAutomationModeValue(value), "yolo", String(value));
  }
  assert.equal(resolveAutomationModeValue("team"), "team");
  assert.equal(resolveAutomationModeValue("bare"), "team");
  assert.equal(resolveAutomationModeValue(" TEAM "), "team");
});

test("模式选择器始终只暴露 yolo / team，并把历史值显示回退为当前档位", () => {
  const legacy = buildAutomationModeOption("build");
  assert.equal(legacy.currentValue, "yolo");
  assert.deepEqual(
    legacy.options?.map((entry) => entry.value),
    ["yolo", "team"],
  );

  const team = buildAutomationModeOption("team");
  assert.equal(team.currentValue, "team");
  assert.deepEqual(
    team.options?.map((entry) => entry.value),
    ["yolo", "team"],
  );
});

test("更新未触碰档位时不提交，创建或显式触碰后才提交", () => {
  assert.equal(shouldSubmitAutomationMode({ isEditing: false, touched: false }), true);
  assert.equal(shouldSubmitAutomationMode({ isEditing: false, touched: true }), true);
  assert.equal(shouldSubmitAutomationMode({ isEditing: true, touched: false }), false);
  assert.equal(shouldSubmitAutomationMode({ isEditing: true, touched: true }), true);
});
