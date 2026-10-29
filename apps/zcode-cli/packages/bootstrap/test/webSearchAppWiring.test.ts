import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { modelMessageContentToText, type WebSearchPort } from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import { createZCodeApp } from "../src/app/create-app.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { createSessionPolicyWebSearchPort } from "../src/zcode-protocol/web-search-port.js";
import {
  FakeModelAdapter,
  TEST_SEARCH_QUERY,
  TEST_SELECTION,
  createFakeProviderRegistry,
  createInactiveWebSearchPort,
  createIsolatedWorkspace,
  createSilentLoggerFactory,
  createStubWebSearchPort,
  createTempSessionStore,
} from "./webSearchWiringTestUtils.js";

// spec: docs/specs/web-search-provider-capability.md
// 回归必须经过生产 App 装配与模型请求，不能只证明假端口能通过门控纯函数。
// 公开 AgentRuntime 类型没有列出内部方法 getTools；这里只补类型声明，实际调用仍走真实 runtime。
type RuntimeWithTools = AgentRuntime & { getTools(): ReadonlyArray<{ name: string }> };

function toolNamesOf(runtime: AgentRuntime): readonly string[] {
  return (runtime as RuntimeWithTools).getTools().map((tool) => tool.name);
}

async function createApp(t: TestContext, webSearchPort?: WebSearchPort) {
  const workspace = await createIsolatedWorkspace(t, "zcode-websearch-app-");
  const sessionStore = createTempSessionStore(workspace.root);
  const modelAdapter = new FakeModelAdapter();
  workspace.cleanupWith(() => sessionStore.close());
  const app = await createZCodeApp({
    env: workspace.env,
    loggerFactory: createSilentLoggerFactory(),
    modelAdapter,
    providerRegistry: createFakeProviderRegistry(),
    runtimeConfig: {
      workingDirectory: workspace.root,
      modelSelection: TEST_SELECTION,
      modelStreaming: "off",
      mode: "yolo",
      maxTurns: 2,
      mcp: { enabled: false },
    },
    sessionStore,
    skipUserConfig: true,
    version: "0.0.0-test",
    webSearchPort,
  });
  workspace.cleanupWith(() => app.close?.());
  return { app, modelAdapter };
}

async function assertModelSearchVisibility(
  t: TestContext,
  port: WebSearchPort | undefined,
  visible: boolean,
) {
  const { app, modelAdapter } = await createApp(t, port);
  assert.equal(toolNamesOf(app.runtime).includes("WebSearch"), visible);
  await app.runtime.executeTurn("search with WebSearch");
  assert.ok(modelAdapter.requests.length > 0, "必须发起真实模型请求");
  assert.equal(
    modelAdapter.requests[0].tools?.some((tool) => tool.name === "WebSearch"),
    visible,
  );
  if (!visible) {
    assert.equal(
      modelAdapter.requests.length,
      1,
      "未声明 WebSearch 时不应出现工具调用后的第二轮请求",
    );
  }
  return modelAdapter.requests;
}

test("真实 App：模型看到 WebSearch，调用同一端口且结果回到模型", async (t) => {
  const port = createStubWebSearchPort();
  const requests = await assertModelSearchVisibility(t, port, true);
  assert.equal(port.searchCalls.length, 1);
  assert.equal(port.searchCalls[0].input.query, TEST_SEARCH_QUERY);
  assert.strictEqual(port.searchCalls[0].provider, port.resolveActiveProvider());
  assert.ok(port.searchCalls[0].options.abortSignal);
  assert.equal(requests.length, 2, "搜索后必须带着结果再次请求模型");
  const result = requests[1].messages.find(
    (message) => message.role === "tool" && message.toolName === "WebSearch",
  );
  assert.ok(result);
  assert.equal(result.isError, false);
  assert.match(modelMessageContentToText(result.content), /https:\/\/stub\.example\/websearch/u);
});

test("真实 App：端口缺席时不向模型声明 WebSearch", async (t) => {
  await assertModelSearchVisibility(t, undefined, false);
});

test("真实 App：无激活搜索源时不向模型声明 WebSearch", async (t) => {
  const port = createInactiveWebSearchPort();
  await assertModelSearchVisibility(t, port, false);
  assert.equal(port.searchCalls.length, 0);
});

test("真实 App：会话创建时搜索关闭，即使有搜索源也不声明 WebSearch", async (t) => {
  const searchPort = createStubWebSearchPort();
  const preferences: ZCodeProtocolAgentServerContext["appRuntimePreferences"] = {
    askUserQuestionAutoResolutionEnabled: false,
    modelIoRecordingEnabled: false,
    modelIoFullRetentionEnabled: false,
    offPeakToolEnabled: false,
    dynamicWorkflowEnabled: false,
    automationEnabled: false,
    webSearchEnabled: false,
  };
  const port = createSessionPolicyWebSearchPort({
    context: { appRuntimePreferences: preferences },
    executor: {
      resolveActiveProvider: (policy) =>
        policy.enabled ? searchPort.resolveActiveProvider() : undefined,
      search: searchPort.search,
      dispose: () => {},
    },
  });
  await assertModelSearchVisibility(t, port, false);
  assert.equal(searchPort.searchCalls.length, 0);
});
