import assert from "node:assert/strict";
import test from "node:test";
import { updateModelIoPreferences } from "../src/zcode-protocol/model-io-preferences.js";

const workspace = {
  workspacePath: "/workspace",
  workspaceKey: "local:/workspace",
};

test("模型轨迹偏好更新运行时快照和所有活跃 session", async () => {
  const calls: Array<[string, boolean]> = [];
  const context = {
    appRuntimePreferences: {
      askUserQuestionAutoResolutionEnabled: true,
      modelIoRecordingEnabled: true,
      modelIoFullRetentionEnabled: false,
      offPeakToolEnabled: false,
      dynamicWorkflowEnabled: false,
      automationEnabled: false,
    },
    sessions: new Map([
      ["one", { app: {
        setModelIoRecordingEnabled: (enabled: boolean) => calls.push(["one-recording", enabled]),
        setModelIoFullRetentionEnabled: (enabled: boolean) => calls.push(["one-retention", enabled]),
      } }],
      ["two", { app: {
        setModelIoRecordingEnabled: (enabled: boolean) => calls.push(["two-recording", enabled]),
        setModelIoFullRetentionEnabled: (enabled: boolean) => calls.push(["two-retention", enabled]),
      } }],
    ]),
  };

  const result = await updateModelIoPreferences(context as never, {
    workspace,
    preferences: { recordingEnabled: false, fullRetentionEnabled: true },
  });

  assert.equal(context.appRuntimePreferences.modelIoRecordingEnabled, false);
  assert.equal(context.appRuntimePreferences.modelIoFullRetentionEnabled, true);
  assert.equal(result.recordingEnabled, false);
  assert.equal(result.fullRetentionEnabled, true);
  assert.equal(result.updatedSessionCount, 2);
  assert.deepEqual(calls, [
    ["one-recording", false],
    ["one-retention", true],
    ["two-recording", false],
    ["two-retention", true],
  ]);
});
