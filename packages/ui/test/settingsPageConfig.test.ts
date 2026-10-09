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
    ["modelProvider", "modelGroups"],
  );
  assert.equal(modelGroup.sections[0]?.titleId, "settings.modelProviderTitle");
  assert.equal(modelGroup.sections[1]?.titleId, "settings.modelGroupsTitle");

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

test("声音与提醒是基础分区、紧跟外观，并提供中英文文案", () => {
  const { settingsSectionGroups, settingsSections } = createSettingsPageConfig();
  const basicsGroup = settingsSectionGroups.find((group) => group.id === "basics");
  assert.ok(basicsGroup, "基础设置分类应存在");
  const ids = basicsGroup.sections.map((section) => section.id);
  assert.ok(ids.includes("sounds"), "基础分区应包含声音与提醒");
  assert.ok(
    ids.indexOf("sounds") > ids.indexOf("appearance"),
    "声音与提醒应排在外观之后",
  );
  assert.equal(
    settingsSections.find((section) => section.id === "sounds")?.titleId,
    "settings.sounds.title",
  );

  assert.equal(zhCN["settings.sounds.title"], "声音与提醒");
  assert.equal(enUS["settings.sounds.title"], "Sounds & notifications");
  assert.equal(zhCN["settings.sounds.event.completed"], "任务完成");
  assert.equal(enUS["settings.sounds.event.failed"], "Task failed");
  assert.equal(zhCN["settings.sounds.pack.minimal"], "简约");
  assert.equal(enUS["settings.sounds.pack.zen"], "Zen");
  // 全量 12 包风格名中英齐备。
  assert.equal(zhCN["settings.sounds.pack.mechanical"], "机械");
  assert.equal(enUS["settings.sounds.pack.cinematic"], "Cinematic");
  assert.equal(zhCN["settings.sounds.pack.arcade"], "街机");
  assert.equal(enUS["settings.sounds.pack.scifi"], "Sci-Fi");
});
