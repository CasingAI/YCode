import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

test("assistant section reading defaults off and accepts only boolean updates", () => {
  assert.equal(appSettingsSchema.parse({}).assistantSectionReadingEnabled, false);
  assert.deepEqual(appSettingsPatchSchema.parse({ assistantSectionReadingEnabled: true }), {
    assistantSectionReadingEnabled: true,
  });
  assert.equal(
    appSettingsPatchSchema.safeParse({ assistantSectionReadingEnabled: "true" }).success,
    false,
  );
});
