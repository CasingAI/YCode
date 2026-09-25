import assert from "node:assert/strict";
import test from "node:test";
import {
  interactionBackgroundHandlers,
  V4CapabilityUnsupportedError,
} from "../src/zcode-protocol-v4/commands/handlers/interaction-background.js";

/**
 * 关闭 Dynamic Workflow 只影响 session 的模型工具面。协议 handler 不应再读取
 * isDynamicWorkflowEnabled；下面的 app 故意不提供这个方法，调用成功即可证明 gate 已移除。
 */
function createConfiguredHost() {
  return {
    getRecord: () => ({
      app: {
        sessionId: "session-workflow-off",
        runtime: { config: { dynamicWorkflowEnabled: false } },
        startSavedWorkflow: async () => ({ ok: true, runId: "run-1", toolCallId: "call-1" }),
        resumeWorkflowRun: async () => ({ ok: true, runId: "run-1", toolCallId: "call-1" }),
        amendWorkflowRunSettings: async () => ({
          ok: true,
          runId: "run-1",
          toolCallId: "call-1",
        }),
      },
    }),
  };
}

function createCapabilityMissingHost() {
  return {
    getRecord: () => ({
      app: { sessionId: "session-workflow-off" },
    }),
  };
}

test("模型工具门关闭时 start handler 仍调用能力，不要求 isDynamicWorkflowEnabled", async () => {
  const result = await interactionBackgroundHandlers.startSavedWorkflow(
    createConfiguredHost() as never,
    { sessionId: "session-workflow-off", payload: { name: "workflow" } } as never,
  );

  assert.deepEqual(result, {
    type: "startSavedWorkflow",
    runId: "run-1",
    toolCallId: "call-1",
  });
});

test("模型工具门关闭时 resume handler 仍调用能力，不要求 isDynamicWorkflowEnabled", async () => {
  const result = await interactionBackgroundHandlers.resumeWorkflowRun(
    createConfiguredHost() as never,
    { sessionId: "session-workflow-off", payload: { workId: "run-1" } } as never,
  );

  assert.equal(result, undefined);
});

test("模型工具门关闭时 amend handler 仍调用能力，不要求 isDynamicWorkflowEnabled", async () => {
  const result = await interactionBackgroundHandlers.amendWorkflowRunSettings(
    createConfiguredHost() as never,
    { sessionId: "session-workflow-off", payload: { workId: "run-1" } } as never,
  );

  assert.deepEqual(result, {
    type: "amendWorkflowRunSettings",
    runId: "run-1",
    toolCallId: "call-1",
  });
});

test("Dynamic Workflow 能力端口缺失仍返回 capability unsupported", async () => {
  const cases = [
    ["startSavedWorkflow", interactionBackgroundHandlers.startSavedWorkflow, { name: "workflow" }],
    ["resumeWorkflowRun", interactionBackgroundHandlers.resumeWorkflowRun, { workId: "run-1" }],
    [
      "amendWorkflowRunSettings",
      interactionBackgroundHandlers.amendWorkflowRunSettings,
      { workId: "run-1" },
    ],
  ] as const;

  for (const [capability, handler, payload] of cases) {
    await assert.rejects(
      handler(
        createCapabilityMissingHost() as never,
        { sessionId: "session-workflow-off", payload } as never,
      ),
      (error: unknown) => {
        assert.ok(error instanceof V4CapabilityUnsupportedError);
        assert.match(error.message, new RegExp(capability));
        return true;
      },
    );
  }
});
