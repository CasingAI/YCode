import assert from "node:assert/strict";
import test from "node:test";
import { resolveProtocolDynamicWorkflowEnabled } from "../src/zcode-protocol/server-operations.js";

test("协议创建/恢复只信任 Host workspace policy，不接受请求字段打开 Dynamic Workflow", () => {
  const context = {
    appRuntimePreferences: {
      askUserQuestionAutoResolutionEnabled: true,
      modelIoFullRetentionEnabled: false,
      offPeakToolEnabled: false,
      dynamicWorkflowEnabled: false,
    },
  };

  assert.equal(
    resolveProtocolDynamicWorkflowEnabled(context, { dynamicWorkflowEnabled: true }),
    false,
  );
  assert.equal(
    resolveProtocolDynamicWorkflowEnabled({
      appRuntimePreferences: {
        askUserQuestionAutoResolutionEnabled: true,
        modelIoFullRetentionEnabled: false,
        offPeakToolEnabled: false,
        dynamicWorkflowEnabled: true,
      },
    }),
    true,
  );
});
