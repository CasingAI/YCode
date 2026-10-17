import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

test("AppSettings 会话产物自动清理默认关闭", () => {
  const settings = appSettingsSchema.parse({});
  assert.equal(settings.sessionArtifactAutoCleanupEnabled, false);
});

test("AppSettings patch 可更新会话产物自动清理并拒绝非法类型", () => {
  assert.equal(
    appSettingsPatchSchema.parse({ sessionArtifactAutoCleanupEnabled: true })
      .sessionArtifactAutoCleanupEnabled,
    true,
  );
  assert.equal(
    appSettingsPatchSchema.parse({ sessionArtifactAutoCleanupEnabled: false })
      .sessionArtifactAutoCleanupEnabled,
    false,
  );
  assert.equal(
    appSettingsPatchSchema.safeParse({ sessionArtifactAutoCleanupEnabled: "true" }).success,
    false,
  );
});
