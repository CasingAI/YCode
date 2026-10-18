import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

test("AppSettings 缺省关闭 Dynamic Workflow，并默认记录模型调用轨迹", () => {
  const settings = appSettingsSchema.parse({});
  assert.equal(settings.dynamicWorkflowEnabled, false);
  assert.equal(settings.modelIoRecordingEnabled, true);
});

test("模型调用轨迹设置 patch 接受布尔值并拒绝非法类型", () => {
  assert.equal(
    appSettingsPatchSchema.parse({ modelIoRecordingEnabled: false }).modelIoRecordingEnabled,
    false,
  );
  assert.equal(
    appSettingsPatchSchema.safeParse({ modelIoRecordingEnabled: "false" }).success,
    false,
  );
});

test("AppSettings patch 接受显式 true/false 并拒绝非法类型", () => {
  assert.equal(
    appSettingsPatchSchema.parse({ dynamicWorkflowEnabled: true }).dynamicWorkflowEnabled,
    true,
  );
  assert.equal(
    appSettingsPatchSchema.parse({ dynamicWorkflowEnabled: false }).dynamicWorkflowEnabled,
    false,
  );
  assert.equal(appSettingsPatchSchema.safeParse({ dynamicWorkflowEnabled: "true" }).success, false);
});
