import assert from "node:assert/strict";
import test from "node:test";
import { resolveProtocolAutomationEnabled } from "../src/zcode-protocol/server-operations.js";

test("协议创建/恢复只信任 Host workspace policy，不接受请求字段打开 Cron 工具面", () => {
  const context = {
    appRuntimePreferences: {
      askUserQuestionAutoResolutionEnabled: true,
      modelIoFullRetentionEnabled: false,
      offPeakToolEnabled: false,
      automationEnabled: false,
    },
  };

  assert.equal(resolveProtocolAutomationEnabled(context, { automationEnabled: true }), false);
  assert.equal(
    resolveProtocolAutomationEnabled({
      appRuntimePreferences: {
        askUserQuestionAutoResolutionEnabled: true,
        modelIoFullRetentionEnabled: false,
        offPeakToolEnabled: false,
        automationEnabled: true,
      },
    }),
    true,
  );
});

test("缺省偏好按关闭处理（automationEnabled 缺席即不注册）", () => {
  assert.equal(
    resolveProtocolAutomationEnabled({
      appRuntimePreferences: {
        askUserQuestionAutoResolutionEnabled: true,
        modelIoFullRetentionEnabled: false,
        offPeakToolEnabled: false,
      },
    }),
    false,
  );
});
