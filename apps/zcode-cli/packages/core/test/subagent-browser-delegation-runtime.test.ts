import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  InMemorySessionEventStore,
  createModelId,
  createModelProviderId,
  createSessionId,
  createToolCallId,
  createTraceId,
  type BrowserControlPort,
  type AgentOutput,
  type CollaborationMode,
  type McpCallToolRequest,
  type McpPort,
  type McpToolDescriptor,
  type Model,
  type ModelRequest,
  type ModelSelection,
  type SessionStorePort,
  type SubagentExecutionFence,
  type SubagentPort,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { SUBAGENT_BROWSER_CONTROL_MODEL_TOOL_NAME } from "../src/subagent/browser-delegation.js";
import type { AgentProfile } from "../src/subagent/profile.js";

// spec: docs/specs/subagent-browser-use-delegation.md
// 用真实 AgentRuntime + 真实子代理工厂验证接线：grant 在 child 执行前签发、所有终态撤销、
// child 的 MCP 请求携带 runtime_scope=subagent / child session id / grantId，且父
// browserControlPort 不会传给 child（否则 turnEnded/closeSession 会清掉 child 页面）。

const SELECTION: ModelSelection = {
  providerId: "demo",
  modelId: "model-a",
  options: { reasoningLevel: "low" },
};

const THIRD_PARTY_MCP_TOOL: McpToolDescriptor = {
  serverName: "thirdparty",
  toolName: "echo",
  description: "Third-party echo tool",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
  },
};

interface DelegationGrantInput {
  parentSessionId: string;
  childSessionId: string;
  agentId: string;
  executionFence: SubagentExecutionFence;
  parentTurnId?: string;
  validateExecutionFence?: (fence: SubagentExecutionFence) => Promise<boolean>;
}

interface DelegationRevokeInput {
  grantId: string;
  childSessionId: string;
  executionFence: SubagentExecutionFence;
}

interface BrowserSpies {
  events: string[];
  grants: DelegationGrantInput[];
  revokes: DelegationRevokeInput[];
  turnEnded: number;
  closeSession: number;
}

function createBrowserControlPort(
  spies: BrowserSpies,
  withDelegation = true,
  grantThrows = false,
): BrowserControlPort {
  const port = {
    list: async () => [],
    execute: async () => ({ ok: true, elapsedMs: 0 }),
    turnEnded: async () => {
      spies.turnEnded += 1;
    },
    closeSession: async () => {
      spies.closeSession += 1;
    },
    ...(withDelegation
      ? {
          subagentDelegation: {
            grant(input: DelegationGrantInput) {
              if (grantThrows) throw new Error("parent session is not active");
              spies.grants.push(input);
              spies.events.push("grant");
              return {
                grantId: `grant-${spies.grants.length}`,
                workspaceKey: "workspace",
                workspacePath: "C:/workspace",
                clientMode: "desktop-continuous",
                issuedAt: 1,
                ...input,
              };
            },
            revoke(input: DelegationRevokeInput) {
              spies.revokes.push(input);
              spies.events.push("revoke");
            },
            authorize() {
              return undefined;
            },
          },
        }
      : {}),
  };
  // 公用契约由另一个切片合入；测试夹具只实现本切片用到的结构。
  return port as unknown as BrowserControlPort;
}

interface ModelHost {
  requests: ModelRequest[];
  invokeTool: boolean;
  toolCalled: boolean;
  fail: boolean;
  toolToCall?: string;
  onFirstRequest?: (request: ModelRequest) => void;
}

function createFakeModel(selection: ModelSelection, host: ModelHost): Model {
  const build = (reasoningLevel: string | undefined): Model => ({
    providerId: createModelProviderId(selection.providerId),
    modelId: createModelId(selection.modelId),
    displayName: `${selection.providerId}/${selection.modelId}`,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 128_000,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: {
        values: reasoningLevel ? [reasoningLevel] : ["low"],
        map: "{}",
      },
      maxOutputTokens: { max: 8192, map: "{}" },
    },
    options: reasoningLevel ? { reasoningLevel } : {},
    bind(bindOptions) {
      return build(bindOptions?.reasoningLevel ?? reasoningLevel);
    },
    async generateText(request: ModelRequest) {
      host.requests.push(request);
      if (host.requests.length === 1) host.onFirstRequest?.(request);
      if (host.fail) throw new Error("model failed");
      const toolNames = (request.tools ?? []).map((tool) => tool.name);
      const targetTool = host.toolToCall ?? SUBAGENT_BROWSER_CONTROL_MODEL_TOOL_NAME;
      const shouldCall = host.invokeTool && !host.toolCalled && toolNames.includes(targetTool);
      if (shouldCall) {
        host.toolCalled = true;
        return {
          text: "",
          finishReason: "tool-calls",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
          toolCalls: [
            {
              id: "call_mcp_1",
              name: targetTool,
              input: { code: "1 + 1", title: "probe" },
            },
          ],
        };
      }
      return {
        text: "done",
        finishReason: "stop",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        toolCalls: [],
      };
    },
    streamText(): AsyncIterable<never> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<never> {
          return {
            next: async () => {
              throw new Error("streamText is not used when modelStreaming is off");
            },
          };
        },
      };
    },
  });
  return build(selection.options?.reasoningLevel);
}

interface McpHost {
  calls: McpCallToolRequest[];
}

function createMcpPort(host: McpHost, extraTools: readonly McpToolDescriptor[] = []): McpPort {
  const nodeReplStatus = {
    status: "connected" as const,
    transport: "stdio" as const,
    toolCount: 1,
    updatedAt: "2000-01-01T00:00:00.000Z",
  };
  const snapshot = {
    statuses: {
      node_repl: nodeReplStatus,
      ...Object.fromEntries(
        extraTools.map((descriptor) => [descriptor.serverName, nodeReplStatus]),
      ),
    },
    tools: [
      {
        serverName: "node_repl",
        toolName: "js",
        description: "Run JavaScript in a persistent Node REPL",
        inputSchema: {
          type: "object",
          properties: { code: { type: "string" } },
          required: ["code"],
        },
      },
      ...extraTools,
    ],
  };
  return {
    connectConfiguredServers: async () => snapshot,
    connectServer: async () => nodeReplStatus,
    disconnectServer: async () => undefined,
    status: async () => snapshot.statuses,
    listTools: async () => snapshot.tools,
    callTool: async (request) => {
      host.calls.push(request);
      return { content: [{ type: "text", text: "2" }] };
    },
    close: async () => {},
  };
}

function createSessionStore(
  options: { withExecutionFenceValidation?: boolean } = {},
): SessionStorePort {
  // 真实 runner 只在首次执行时要求原子初始化 + Claim；child runtime 落库时复用同一 child。
  // 执行级 claim 是同一组能力：没有 renew 权威校验时同时不提供 initialize/acquire，
  // child 走普通无 fence 执行，避免「有 fence 但无法校验」的半套接线。
  const claimCapability =
    options.withExecutionFenceValidation === false
      ? {}
      : {
          initializeSubagentFirstExecution: async (init: {
            input: { id: string };
            ownerRuntimeId: string;
          }) => ({
            child: { id: init.input.id },
            claim: {
              childSessionId: init.input.id,
              ownerRuntimeId: init.ownerRuntimeId,
              fencingEpoch: 3,
              expiresAt: Date.now() + 120_000,
            },
          }),
          acquireSubagentExecutionClaim: async (input: {
            childSessionId: string;
            ownerRuntimeId: string;
          }) => ({
            acquired: true,
            claim: {
              childSessionId: input.childSessionId,
              ownerRuntimeId: input.ownerRuntimeId,
              fencingEpoch: 4,
              expiresAt: Date.now() + 120_000,
            },
          }),
          renewSubagentExecutionClaim: async () => true,
          releaseSubagentExecutionClaim: async () => true,
        };
  return {
    createSession: async (input: { id: string }) => ({ id: input.id }),
    ...claimCapability,
    getSession: async (id: string) => ({
      id,
      title: `subagent-${id}`,
      directory: "C:/workspace",
      path: "C:/workspace",
      time: {},
    }),
    saveSessionEntry: async () => {},
    saveMessage: async () => {},
    savePart: async () => {},
    messages: async () => [],
    parts: async () => [],
  } as unknown as SessionStorePort;
}

interface Harness {
  runtime: AgentRuntime;
  internal: AgentRuntimeInternal;
  subagentPort: SubagentPort;
  spies: BrowserSpies;
  mcpHost: McpHost;
  modelHost: ModelHost;
  workingDirectory: string;
}

async function createHarness(
  t: TestContext,
  options: {
    mode?: CollaborationMode;
    browserUse?: boolean;
    withDelegation?: boolean;
    withExecutionFenceValidation?: boolean;
    grantThrows?: boolean;
    withBrowserPort?: boolean;
    withModelFactory?: boolean;
    profiles?: readonly AgentProfile[];
    invokeTool?: boolean;
    failModel?: boolean;
    extraMcpTools?: readonly McpToolDescriptor[];
    toolToCall?: string;
    onFirstRequest?: (request: ModelRequest) => void;
  } = {},
): Promise<Harness> {
  const workingDirectory = await mkdtemp(path.join(tmpdir(), "zcode-subagent-browser-"));
  t.after(() => rm(workingDirectory, { recursive: true, force: true }));

  const spies: BrowserSpies = {
    events: [],
    grants: [],
    revokes: [],
    turnEnded: 0,
    closeSession: 0,
  };
  const mcpHost: McpHost = { calls: [] };
  const modelHost: ModelHost = {
    requests: [],
    invokeTool: options.invokeTool ?? false,
    toolCalled: false,
    fail: options.failModel ?? false,
    ...(options.toolToCall ? { toolToCall: options.toolToCall } : {}),
    ...(options.onFirstRequest ? { onFirstRequest: options.onFirstRequest } : {}),
  };
  const eventStore = new InMemorySessionEventStore();
  const runtime = new AgentRuntime(
    createSessionId(),
    {
      mode: options.mode ?? "yolo",
      modelStreaming: "off",
      modelSelection: SELECTION,
      workingDirectory,
      workspacePath: workingDirectory,
      runtimeFeatures: { browserUse: options.browserUse ?? true },
      subagents: {
        enabled: true,
        profiles: options.profiles ?? [],
        maxTurns: 2,
      },
      mcp: { servers: { node_repl: { type: "stdio", command: "node" } } },
    },
    {
      eventStore,
      sessionStore: createSessionStore({
        withExecutionFenceValidation: options.withExecutionFenceValidation,
      }),
      ...(options.withModelFactory === false
        ? { modelFactory: undefined as never }
        : {
            modelFactory: (input: { selection: ModelSelection }) =>
              createFakeModel(input.selection, modelHost),
          }),
      mcpPort: createMcpPort(mcpHost, options.extraMcpTools ?? []),
      ...(options.withBrowserPort === false
        ? {}
        : {
            browserControlPort: createBrowserControlPort(
              spies,
              options.withDelegation ?? true,
              options.grantThrows ?? false,
            ),
          }),
    },
  );
  t.after(() => runtime.beginShutdown());
  const internal = runtime as unknown as AgentRuntimeInternal;
  const subagentPort = internal.subagentPort;
  if (!subagentPort) throw new Error("AgentRuntime did not create a subagentPort");
  return { runtime, internal, subagentPort, spies, mcpHost, modelHost, workingDirectory };
}

interface RunOptions {
  agentType?: string;
  signal?: AbortSignal;
}

async function runSubagent(harness: Harness, options: RunOptions = {}): Promise<AgentOutput> {
  const result = await harness.subagentPort.run(
    {
      sessionId: harness.runtime.getSessionId(),
      parentToolCallId: createToolCallId(),
      agentType: options.agentType ?? "general-purpose",
      description: "browser delegation probe",
      prompt: "probe the browser surface",
      workingDirectory: harness.workingDirectory,
      workspaceRoot: harness.workingDirectory,
      trace: { traceId: createTraceId() },
    },
    options.signal ? { signal: options.signal } : undefined,
  );
  return result;
}

test("父完全访问 + node_repl js：执行前签发 grant，child MCP 请求带 child id 与 grantId，终态撤销", async (t) => {
  const harness = await createHarness(t, { invokeTool: true });

  const result = await runSubagent(harness);

  assert.equal(result.status, "completed");
  assert.equal(harness.spies.grants.length, 1, "每次 child execution 签发一次 grant");
  const grant = harness.spies.grants[0];
  assert.ok(grant);
  assert.equal(grant.parentSessionId, String(harness.runtime.getSessionId()));
  assert.equal(grant.executionFence.fencingEpoch, 3);
  // broker 每次带 grant 的 list/execute 前 await 该回调；runtime 必须注入 SessionStore
  // 的权威 claim 复核，而不是让 broker 只比较自己的 fence 水位。
  assert.equal(typeof grant.validateExecutionFence, "function");
  assert.equal(await grant.validateExecutionFence!(grant.executionFence), true);

  const call = harness.mcpHost.calls[0] as
    | (McpCallToolRequest & { subagentBrowserGrantId?: string })
    | undefined;
  assert.ok(call, "child 必须真的调用 node_repl MCP");
  assert.equal(call.runtimeScope, "subagent");
  assert.equal(call.trace?.sessionId, grant.childSessionId, "trace session_id 必须是 child");
  assert.equal(call.subagentBrowserGrantId, "grant-1");
  assert.notEqual(call.trace?.sessionId, String(harness.runtime.getSessionId()));

  assert.deepEqual(harness.spies.events, ["grant", "revoke"]);
  assert.deepEqual(harness.spies.revokes, [
    {
      grantId: "grant-1",
      childSessionId: grant.childSessionId,
      executionFence: grant.executionFence,
    },
  ]);
  // 父端口不能被 child 继承，否则 child 终态会清掉自己的页面。
  assert.equal(harness.spies.turnEnded, 0);
  assert.equal(harness.spies.closeSession, 0);
});

test("child 执行失败仍撤销 grant", async (t) => {
  const harness = await createHarness(t, { failModel: true });

  const result = await runSubagent(harness);

  assert.equal(result.status, "failed");
  assert.equal(harness.spies.grants.length, 1);
  assert.equal(harness.spies.revokes.length, 1);
  assert.equal(harness.spies.revokes[0]?.grantId, "grant-1");
});

test("child 取消沿用原 abort，finally 撤销 grant", async (t) => {
  const controller = new AbortController();
  const harness = await createHarness(t, {
    invokeTool: true,
    onFirstRequest: () => controller.abort(),
  });

  await runSubagent(harness, { signal: controller.signal }).catch(() => {});

  assert.equal(harness.spies.grants.length, 1);
  assert.equal(harness.spies.revokes.length, 1);
});

test("child 初始化异常（模型工厂缺失）也撤销 grant", async (t) => {
  const harness = await createHarness(t, { withModelFactory: false });

  const result = await runSubagent(harness);

  assert.equal(result.status, "failed");
  assert.equal(harness.spies.grants.length, 1);
  assert.equal(harness.spies.revokes.length, 1);
});

test("连续两次执行各自签发独立 grant，旧 grant 撤销不影响新执行", async (t) => {
  const harness = await createHarness(t, { invokeTool: true });

  await runSubagent(harness);
  harness.modelHost.toolCalled = false;
  await runSubagent(harness);

  assert.deepEqual(
    harness.spies.grants.map((grant) => grant.childSessionId),
    [harness.spies.revokes[0]?.childSessionId, harness.spies.revokes[1]?.childSessionId],
  );
  assert.equal(harness.spies.grants.length, 2);
  assert.equal(harness.spies.revokes.length, 2);
  assert.notEqual(harness.spies.grants[0]?.childSessionId, harness.spies.grants[1]?.childSessionId);
  assert.deepEqual(
    harness.mcpHost.calls.map((call) => (call as McpCallToolRequest).subagentBrowserGrantId),
    ["grant-1", "grant-2"],
  );
  assert.deepEqual(harness.spies.events, ["grant", "revoke", "grant", "revoke"]);
});

test("grant 签发失败：child 正常执行，仅浏览器能力缺席", async (t) => {
  const harness = await createHarness(t, { invokeTool: true, grantThrows: true });

  const result = await runSubagent(harness);

  assert.equal(result.status, "completed");
  assert.equal(harness.spies.grants.length, 0);
  assert.equal(harness.spies.revokes.length, 0);
  const call = harness.mcpHost.calls[0] as McpCallToolRequest | undefined;
  assert.ok(call, "授权失败不应阻止 child 执行其他工具");
  assert.equal(call.subagentBrowserGrantId, undefined);
});

test("父 plan：工具面可见但绝不签发 grant", async (t) => {
  const readonlyProfile: AgentProfile = {
    name: "read-only-worker",
    description: "read-only",
    source: "user",
    systemPrompt: "read-only",
    permissionMode: "readonly",
  };
  const harness = await createHarness(t, {
    mode: "plan",
    profiles: [readonlyProfile],
    invokeTool: false,
  });

  await runSubagent(harness, { agentType: readonlyProfile.name });

  assert.equal(harness.spies.grants.length, 0);
  assert.equal(harness.spies.revokes.length, 0);
});

test("profile readonly：不签发 grant", async (t) => {
  const readonlyProfile: AgentProfile = {
    name: "read-only-worker",
    description: "read-only",
    source: "user",
    systemPrompt: "read-only",
    permissionMode: "readonly",
  };
  const harness = await createHarness(t, {
    profiles: [readonlyProfile],
    invokeTool: false,
  });

  await runSubagent(harness, { agentType: readonlyProfile.name });

  assert.equal(harness.spies.grants.length, 0);
});

test("内置 Explore：不签发 grant", async (t) => {
  const harness = await createHarness(t, { invokeTool: false });

  await runSubagent(harness, { agentType: "Explore" });

  assert.equal(harness.spies.grants.length, 0);
});

test("profile disallow node_repl js：不签发 grant", async (t) => {
  const restrictedProfile: AgentProfile = {
    name: "no-browser",
    description: "browser-disallowed",
    source: "user",
    systemPrompt: "no-browser",
    disallowedTools: [SUBAGENT_BROWSER_CONTROL_MODEL_TOOL_NAME],
  };
  const harness = await createHarness(t, {
    profiles: [restrictedProfile],
    invokeTool: false,
  });

  await runSubagent(harness, { agentType: restrictedProfile.name });

  assert.equal(harness.spies.grants.length, 0);
});

test("child 调用第三方 MCP 工具：即使持有 grant 也不透传", async (t) => {
  const harness = await createHarness(t, {
    invokeTool: true,
    extraMcpTools: [THIRD_PARTY_MCP_TOOL],
    toolToCall: "mcp__thirdparty__echo",
  });

  const result = await runSubagent(harness);

  assert.equal(result.status, "completed");
  // node_repl js 仍在工具面，所以本次执行本身有 grant。
  assert.equal(harness.spies.grants.length, 1);
  const call = harness.mcpHost.calls[0] as
    | (McpCallToolRequest & { subagentBrowserGrantId?: string })
    | undefined;
  assert.ok(call);
  assert.equal(call.serverName, "thirdparty");
  assert.equal(call.runtimeScope, "subagent");
  assert.equal(call.subagentBrowserGrantId, undefined);
});

test("SendMessage 续跑：重新签发新 grant/fence，旧 grant 撤销只作用于旧执行", async (t) => {
  const harness = await createHarness(t, { invokeTool: true });

  await runSubagent(harness);
  const firstGrant = harness.spies.grants[0];
  assert.ok(firstGrant);
  harness.modelHost.toolCalled = false;

  const sent = await harness.subagentPort.sendMessage!({
    sessionId: harness.runtime.getSessionId(),
    parentToolCallId: createToolCallId(),
    to: firstGrant.agentId,
    summary: "continue browser probe",
    message: "probe the browser surface again",
    workingDirectory: harness.workingDirectory,
    workspaceRoot: harness.workingDirectory,
    trace: { traceId: createTraceId() },
  });

  assert.equal(sent.status, "success");
  assert.equal(harness.spies.grants.length, 2);
  const [nextGrant] = harness.spies.grants.slice(1);
  assert.ok(nextGrant);
  assert.equal(nextGrant.childSessionId, firstGrant.childSessionId, "续跑复用同一 child session");
  assert.equal(nextGrant.executionFence.fencingEpoch, 4, "续跑使用新 claim 的 fence");
  assert.notEqual(nextGrant.executionFence.fencingEpoch, firstGrant.executionFence.fencingEpoch);

  const calls = harness.mcpHost.calls as (McpCallToolRequest & {
    subagentBrowserGrantId?: string;
  })[];
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.subagentBrowserGrantId, "grant-1");
  assert.equal(calls[1]?.subagentBrowserGrantId, "grant-2");
  assert.equal(calls[1]?.trace?.sessionId, firstGrant.childSessionId);

  // 旧执行先撤销自己的 grant；续跑签发的新 grant 使用不同 id + fence。broker 的
  // grantId/child/fence 精确匹配拒绝组合由 broker 测试覆盖。
  assert.deepEqual(
    harness.spies.revokes.map((input) => input.grantId),
    ["grant-1", "grant-2"],
  );
  assert.deepEqual(harness.spies.revokes[0]?.executionFence, firstGrant.executionFence);
  assert.deepEqual(harness.spies.revokes[1]?.executionFence, nextGrant.executionFence);
  assert.deepEqual(harness.spies.events, ["grant", "revoke", "grant", "revoke"]);
});

test("SessionStore 无 renew 权威校验：普通子任务照常，浏览器不签发 grant", async (t) => {
  const harness = await createHarness(t, {
    invokeTool: true,
    withExecutionFenceValidation: false,
  });

  // 没有 renewSubagentExecutionClaim 时 broker 只能做内存校验，无法发现 claim 已释放
  // 或 epoch 已接管，因此不能签发 grant；child 其余工具照常执行。
  const result = await runSubagent(harness);

  assert.equal(result.status, "completed");
  assert.equal(harness.spies.grants.length, 0);
  const call = harness.mcpHost.calls[0] as
    | (McpCallToolRequest & { subagentBrowserGrantId?: string })
    | undefined;
  assert.ok(call);
  assert.equal(call.runtimeScope, "subagent");
  assert.equal(call.subagentBrowserGrantId, undefined);
});

test("宿主没有授权端口：child 正常执行但 MCP 请求不带 grant", async (t) => {
  const harness = await createHarness(t, { invokeTool: true, withDelegation: false });

  // withDelegation=false 只是不暴露细分端口；这里用独立断言确认请求不透传任何 grant。
  const result = await runSubagent(harness);

  assert.equal(result.status, "completed");
  assert.equal(harness.spies.grants.length, 0);
  const call = harness.mcpHost.calls[0] as
    | (McpCallToolRequest & { subagentBrowserGrantId?: string })
    | undefined;
  assert.ok(call);
  assert.equal(call.runtimeScope, "subagent");
  assert.equal(call.subagentBrowserGrantId, undefined);
});
