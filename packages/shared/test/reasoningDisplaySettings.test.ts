import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

test("旧思考显示设置与迁移标记不再进入设置状态", () => {
  const settings = appSettingsSchema.parse({
    messageStreamShowReasoning: false,
    messageStreamShowReasoningMigrationInitialized: true,
  });

  assert.equal("messageStreamShowReasoning" in settings, false);
  assert.equal("messageStreamShowReasoningMigrationInitialized" in settings, false);
  assert.deepEqual(
    appSettingsPatchSchema.parse({
      messageStreamShowReasoning: false,
      messageStreamShowReasoningMigrationInitialized: true,
    }),
    {},
  );
});
