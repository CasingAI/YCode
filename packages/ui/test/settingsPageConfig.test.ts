import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { createSettingsPageConfig } from "../src/settings/settingsPageConfig.js";

test("模型供应商入口位于独立模型分类，并保留原 section id", () => {
  const { settingsSectionGroups, settingsSections } = createSettingsPageConfig();
  const groupIds = settingsSectionGroups.map((group) => group.id);

  assert.deepEqual(groupIds, ["basics", "models", "agentCapabilities", "dataAndStats"]);

  const modelGroup = settingsSectionGroups.find((group) => group.id === "models");
  assert.ok(modelGroup, "模型分类应出现在设置侧栏分组中");
  assert.deepEqual(
    modelGroup.sections.map((section) => section.id),
    ["modelProvider"],
  );
  assert.equal(modelGroup.sections[0]?.titleId, "settings.modelProviderTitle");

  const basicsGroup = settingsSectionGroups.find((group) => group.id === "basics");
  assert.ok(basicsGroup, "基础设置分类应存在");
  assert.equal(
    basicsGroup.sections.some((section) => section.id === "modelProvider"),
    false,
  );
  assert.equal(
    settingsSections.find((section) => section.id === "modelProvider")?.groupId,
    "models",
  );
});

test("模型分类和供应商入口提供中英文文案", () => {
  assert.equal(zhCN["settings.sidebar.group.models"], "模型");
  assert.equal(zhCN["settings.modelProviderTitle"], "供应商和模型");
  assert.equal(enUS["settings.sidebar.group.models"], "Models");
  assert.equal(enUS["settings.modelProviderTitle"], "Providers and models");
});
