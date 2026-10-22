import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/**
 * 引导下线后的边界（见 docs/specs/onboarding-removal.md）。
 *
 * 删掉的是「职业 / 界面模式 / 偏好」这一整套问卷向导：设置页的两个入口、组件本身、
 * 引导记录通道和打开它的快捷键。迁移向导（从外部工具导入会话 / Skills / MCP / 命令）
 * 必须保留，并把入口改挂成设置页的「数据迁移」行。
 *
 * ui 包测试为源码断言式（无 DOM 测试环境），这里锁定删除方向与保留能力。
 */

const uiSrc = new URL("../src/", import.meta.url);
const read = (relativePath: string) => readFileSync(new URL(relativePath, uiSrc), "utf8");

const sectionNavSource = read("settings/SettingsSectionNav.tsx");
const generalSectionSource = read("settingsPageHelpers.tsx");
const rootSource = read("Root.tsx");
const storeSource = read("store/index.ts");
const sharedChannelsSource = readFileSync(
  new URL("../../shared/src/channels.ts", import.meta.url),
  "utf8",
);
const sharedShortcutSource = readFileSync(
  new URL("../../shared/src/shortcutCommands.ts", import.meta.url),
  "utf8",
);

test("设置页不再提供职业引导入口", () => {
  assert.doesNotMatch(sectionNavSource, /onOpenOnboarding/, "侧栏不得再有引导入口");
  assert.doesNotMatch(sectionNavSource, /settings\.onboarding/, "侧栏不得再引用引导文案");
  assert.doesNotMatch(generalSectionSource, /onOpenOnboardingDialog/, "通用分区不得再有引导入口");
  assert.doesNotMatch(storeSource, /newUserOnboardingOpen/, "store 不得再保留引导开关");
});

test("职业引导组件与引导记录通道已删除", () => {
  for (const relativePath of [
    "onboarding/OccupationOnboarding.tsx",
    "onboarding/occupationOptions.ts",
    "onboarding/useOnboardingTelemetry.ts",
    "onboarding/useOnboardingTrigger.ts",
    "hooks/useOnboardingRecordService.ts",
  ]) {
    assert.equal(existsSync(new URL(relativePath, uiSrc)), false, `${relativePath} 应已删除`);
  }
  assert.equal(
    existsSync(new URL("../../shared/src/onboardingRecord.ts", import.meta.url)),
    false,
    "引导记录契约应已删除",
  );
  assert.doesNotMatch(sharedChannelsSource, /OnboardingRecord/, "引导记录通道应已注销");
});

test("打开引导的快捷键命令已删除", () => {
  assert.doesNotMatch(sharedShortcutSource, /openOnboarding/, "快捷键命令表不得再有引导命令");
});

test("迁移向导保留，并改挂为设置页的「数据迁移」入口", () => {
  assert.match(generalSectionSource, /onOpenDataMigration/, "通用分区必须保留数据迁移入口");
  assert.match(generalSectionSource, /settings\.dataMigrationOpen/, "数据迁移行必须有按钮文案");
  assert.match(rootSource, /OnboardingDialog/, "迁移向导必须继续挂载");
  assert.equal("settings.dataMigration" in zhCN, true);
  assert.equal("settings.dataMigration" in enUS, true);
});

test("引导相关文案已清理", () => {
  for (const key of [
    "settings.onboarding",
    "settings.onboardingDescription",
    "settings.onboardingOpen",
    "occupationOnboarding.title",
    "settings.shortcuts.command.openOnboarding",
  ]) {
    assert.equal(key in zhCN, false, `${key} 应已从中文文案移除`);
    assert.equal(key in enUS, false, `${key} 应已从英文文案移除`);
  }
});
