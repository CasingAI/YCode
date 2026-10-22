import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

test("AppSettings 会话产物占用提示默认开启", () => {
  const settings = appSettingsSchema.parse({});
  assert.equal(settings.sessionStorageWarningEnabled, true);
});

test("AppSettings patch 可更新会话产物占用提示并拒绝非法类型", () => {
  assert.equal(
    appSettingsPatchSchema.parse({ sessionStorageWarningEnabled: false })
      .sessionStorageWarningEnabled,
    false,
  );
  assert.equal(
    appSettingsPatchSchema.parse({ sessionStorageWarningEnabled: true })
      .sessionStorageWarningEnabled,
    true,
  );
  assert.equal(
    appSettingsPatchSchema.safeParse({ sessionStorageWarningEnabled: "true" }).success,
    false,
  );
});
