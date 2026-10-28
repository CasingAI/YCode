import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

test("默认设置与旧待办显示字段不再进入设置状态", () => {
  assert.equal("messageStreamShowTodos" in appSettingsSchema.parse({}), false);

  for (const messageStreamShowTodos of [false, true]) {
    const settings = appSettingsSchema.parse({ messageStreamShowTodos, locale: "zh-CN" });
    assert.equal("messageStreamShowTodos" in settings, false);
    assert.equal(settings.locale, "zh-CN");
  }
});

test("待办显示字段不再进入设置 patch", () => {
  assert.deepEqual(appSettingsPatchSchema.parse({ messageStreamShowTodos: false }), {});
  assert.deepEqual(appSettingsPatchSchema.parse({ messageStreamShowTodos: true }), {});
});
