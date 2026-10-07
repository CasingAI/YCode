import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

test("AppSettings 缺省开启「不归档有组的会话」", () => {
  const settings = appSettingsSchema.parse({});
  assert.equal(settings.taskAutoArchiveSkipGrouped, true);
  // 归档总开关默认值不受新设置影响，保持关闭。
  assert.equal(settings.taskAutoArchiveEnabled, false);
  assert.equal(settings.taskAutoArchiveOlderThanDays, 7);
});

test("AppSettings 显式存过 false 的用户升级后保持关闭", () => {
  const settings = appSettingsSchema.parse({ taskAutoArchiveSkipGrouped: false });
  assert.equal(settings.taskAutoArchiveSkipGrouped, false);
});

test("AppSettings patch 接受显式 true/false 并拒绝非法类型", () => {
  assert.equal(
    appSettingsPatchSchema.parse({ taskAutoArchiveSkipGrouped: true }).taskAutoArchiveSkipGrouped,
    true,
  );
  assert.equal(
    appSettingsPatchSchema.parse({ taskAutoArchiveSkipGrouped: false }).taskAutoArchiveSkipGrouped,
    false,
  );
  assert.equal(
    appSettingsPatchSchema.safeParse({ taskAutoArchiveSkipGrouped: "true" }).success,
    false,
  );
});
