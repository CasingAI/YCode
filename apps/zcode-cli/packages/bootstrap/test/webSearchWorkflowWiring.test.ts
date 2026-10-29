import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createConfig } from "@zcode/adapters/config";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import {
  createRootTraceContext,
  createSessionId,
  modelMessageContentToText,
  type ContextSourcePort,
  type ModelRequest,
} from "@zcode/contracts";
import { AgentRuntime, PermissionService } from "@zcode/core";
import { NoopAgentExecutionTelemetry } from "@zcode/telemetry";
import {
  createScriptWorkflowAgentRuntime,
  type ScriptWorkflowAgentRuntimeDeps,
} from "../src/app/script-workflow-child-runtime.js";
import { createWorkflowChildRuntime } from "../src/app/workflow-facade.js";
import {
  FakeModelAdapter,
  TEST_SEARCH_QUERY,
  TEST_SELECTION,
  createFakeProviderRegistry,
  createIsolatedWorkspace,
  createSilentLogger,
  createStubWebSearchPort,
  createTempSessionStore,
} from "./webSearchWiringTestUtils.js";

// spec: docs/specs/web-search-provider-capability.md
// 两类工作流工厂必须把父端口用于声明与执行，且不能突破现有工具范围。
// 公开 AgentRuntime 类型没有列出内部方法 getTools；这里只补类型声明，实际调用仍走真实 runtime。
type RuntimeWithTools = AgentRuntime & { getTools(): ReadonlyArray<{ name: string }> };

function toolNamesOf(runtime: AgentRuntime): readonly string[] {
  return (runtime as RuntimeWithTools).getTools().map((tool) => tool.name);
}

async function createHarness(t: TestContext) {
  const workspace = await createIsolatedWorkspace(t, "zcode-websearch-workflow-");
  const port = createStubWebSearchPort();
  const sessionStore = createTempSessionStore(workspace.root);
  workspace.cleanupWith(() => sessionStore.close());
  const sessionId = createSessionId();
  const traceContext = createRootTraceContext({ sessionId });
  const modelAdapter = new FakeModelAdapter();
  const providerRegistry = createFakeProviderRegistry();
  const provider = providerRegistry.getProvider(TEST_SELECTION.providerId);
  const model = providerRegistry.getModel(TEST_SELECTION.providerId, TEST_SELECTION.modelId);
  assert.ok(provider, "测试 Registry 必须提供选中供应商");
  assert.ok(model, "测试 Registry 必须提供选中模型");
  const modelFactory: ScriptWorkflowAgentRuntimeDeps["modelFactory"] = () =>
    modelAdapter.createModel({
      providerId: TEST_SELECTION.providerId,
      modelId: TEST_SELECTION.modelId,
      providerConfig: provider.config,
      modelConfig: model.config,
      options: TEST_SELECTION.options,
    });
  const contextSourcePort: ContextSourcePort = {
    async resolveContextSources(request) {
      return {
        workingDirectory: request.workingDirectory,
        envInfo: {
          cwd: request.workingDirectory,
          platform: "test",
          shell: "test",
          osVersion: "test",
          nodeVersion: process.version,
        },
        diagnostics: [],
      };
    },
  };
  const fileSystemPort = createNodeFileSystemAdapter();
  const permissionService = new PermissionService({
    allowedTools: new Set(),
    disallowedTools: new Set(),
    autoApproveHighRisk: false,
    allowMediumRiskInAutoMode: false,
  });
  const runtimeConfig = {
    workingDirectory: workspace.root,
    modelSelection: TEST_SELECTION,
    modelStreaming: "off" as const,
    maxTurns: 2,
  };
  const runtime = new AgentRuntime(sessionId, runtimeConfig, {
    eventStore: createInMemorySessionEventStore(),
    modelFactory,
    sessionStore,
    webSearchPort: port,
    contextSourcePort,
  });
  workspace.cleanupWith(() => runtime.beginShutdown());
  const deps: ScriptWorkflowAgentRuntimeDeps = {
    agentTelemetry: new NoopAgentExecutionTelemetry(),
    appOptions: { env: workspace.env, providerRegistry, webSearchPort: port, contextSourcePort },
    appVersion: "0.0.0-test",
    configResult: createConfig({
      env: workspace.env,
      workingDirectory: workspace.root,
      skipUserConfig: true,
    }),
    contextSourcePort,
    fileSystemPort,
    imageProcessorPort: {
      async resizeToFit() {
        throw new Error("测试不应处理图片");
      },
      async prepareForModel() {
        throw new Error("测试不应处理图片");
      },
    },
    logger: createSilentLogger(),
    modelFactory,
    permissionService,
    runtime,
    runtimeConfig,
    sessionId,
    sessionStore,
    storageRoot: workspace.root,
    workingDirectory: workspace.root,
  };
  return { deps, modelAdapter, port, traceContext, workspace };
}

function assertResultReturned(requests: readonly ModelRequest[]) {
  assert.equal(requests.length, 2);
  assert.ok(requests[0].tools?.some((tool) => tool.name === "WebSearch"));
  const result = requests[1].messages.find(
    (message) => message.role === "tool" && message.toolName === "WebSearch",
  );
  assert.ok(result, "工具结果必须返回模型上下文");
  assert.equal(result.isError, false);
  assert.match(modelMessageContentToText(result.content), /https:\/\/stub\.example\/websearch/u);
}

test("脚本工作流：父端口可搜索，禁用表仍能移除 WebSearch", async (t) => {
  const allowedHarness = await createHarness(t);
  const allowed = createScriptWorkflowAgentRuntime({
    childSessionId: createSessionId(),
    deps: allowedHarness.deps,
    request: { prompt: "search", opts: {} },
    traceContext: allowedHarness.traceContext,
  });
  allowedHarness.workspace.cleanupWith(() => allowed.beginShutdown());
  await allowed.executeTurn("search");
  assert.equal(allowedHarness.port.searchCalls.length, 1);
  assert.strictEqual(
    allowedHarness.port.searchCalls[0].provider,
    allowedHarness.port.resolveActiveProvider(),
  );
  assert.equal(allowedHarness.port.searchCalls[0].input.query, TEST_SEARCH_QUERY);
  assertResultReturned(allowedHarness.modelAdapter.requests);

  // 禁用用例用独立 Harness：假模型的「只调用一次」状态不能跨用例复用，
  // 否则「端口未被调用」会因上一用例已消费调用而虚假成立。
  const deniedHarness = await createHarness(t);
  const denied = createScriptWorkflowAgentRuntime({
    childSessionId: createSessionId(),
    deps: deniedHarness.deps,
    request: { prompt: "search", opts: {} },
    traceContext: deniedHarness.traceContext,
    configOverrides: { toolDisallowlist: ["WebSearch"] },
  });
  deniedHarness.workspace.cleanupWith(() => denied.beginShutdown());
  await denied.executeTurn("search");
  assert.equal(deniedHarness.modelAdapter.requests.length, 1, "禁用后不应出现工具调用轮");
  assert.ok(
    !deniedHarness.modelAdapter.requests[0].tools?.some((tool) => tool.name === "WebSearch"),
    "禁用表必须从真实模型请求的工具面移除 WebSearch",
  );
  assert.ok(!toolNamesOf(denied).includes("WebSearch"));
  assert.equal(deniedHarness.port.searchCalls.length, 0, "禁用表生效后不得触达父端口");
});

test("传统工作流：父端口可搜索，白名单仍能收窄到 Read", async (t) => {
  const allowedHarness = await createHarness(t);
  const allowedDeps: Parameters<typeof createWorkflowChildRuntime>[0] = {
    ...allowedHarness.deps,
    cliStorageRoot: allowedHarness.workspace.root,
    prepareUserExecutionBoundary: async () => {},
    traceContext: allowedHarness.traceContext,
  };
  const allowed = createWorkflowChildRuntime(allowedDeps, {
    childSessionId: createSessionId(),
    childTraceContext: allowedHarness.traceContext,
    workflowKind: "expert",
  });
  allowedHarness.workspace.cleanupWith(() => allowed.beginShutdown());
  await allowed.executeTurn("search");
  assert.equal(allowedHarness.port.searchCalls.length, 1);
  assert.strictEqual(
    allowedHarness.port.searchCalls[0].provider,
    allowedHarness.port.resolveActiveProvider(),
  );
  assert.equal(allowedHarness.port.searchCalls[0].input.query, TEST_SEARCH_QUERY);
  assertResultReturned(allowedHarness.modelAdapter.requests);

  // 白名单收窄同样用独立 Harness，保证「端口零调用」不是上一用例消耗调用后的假象。
  const deniedHarness = await createHarness(t);
  const deniedDeps: Parameters<typeof createWorkflowChildRuntime>[0] = {
    ...deniedHarness.deps,
    cliStorageRoot: deniedHarness.workspace.root,
    prepareUserExecutionBoundary: async () => {},
    traceContext: deniedHarness.traceContext,
    runtimeConfig: { ...deniedHarness.deps.runtimeConfig, toolAllowlist: ["Read"] },
  };
  const denied = createWorkflowChildRuntime(deniedDeps, {
    childSessionId: createSessionId(),
    childTraceContext: deniedHarness.traceContext,
    workflowKind: "expert",
  });
  deniedHarness.workspace.cleanupWith(() => denied.beginShutdown());
  await denied.executeTurn("search");
  assert.equal(deniedHarness.modelAdapter.requests.length, 1, "白名单收窄后不应出现工具调用轮");
  assert.ok(
    !deniedHarness.modelAdapter.requests[0].tools?.some((tool) => tool.name === "WebSearch"),
    "白名单必须从真实模型请求的工具面移除 WebSearch",
  );
  assert.ok(!toolNamesOf(denied).includes("WebSearch"));
  assert.equal(deniedHarness.port.searchCalls.length, 0, "白名单收窄后不得触达父端口");
});
