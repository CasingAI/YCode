import assert from "node:assert/strict";
import test from "node:test";
import { ModelApiOperation, createTraceId, type ActiveWebSearchProvider } from "@zcode/contracts";
import { runMemoryAgentLoop } from "../src/memory/memory-agent-loop.js";
import type { AgentProfile } from "../src/subagent/profile.js";
import { captureProjectMemoryAgentContext } from "../src/runtime/helpers/project-memory-agent.js";
import {
  ACTIVE_PROVIDER,
  OTHER_PROVIDER,
  PARENT_SELECTION,
  STUB_RESULT_URL,
  WEBSEARCH_QUERY,
  createFakeModel,
  createIsolatedWorkspace,
  createParentHarness,
  createSnapshotStubPort,
  createStubPort,
  runSubagent,
  type FakeModelHost,
} from "./websearchRuntimeInheritanceHarness.js";

// spec: docs/specs/web-search-provider-capability.md
//
// WebSearch 的执行后端是宿主注入的 WebSearchPort。子代理只**借用**父会话同一个端口，
// 不另建快照、不另读策略：漏传会让子代理既不向模型声明 WebSearch（已启用却不可见），
// 执行侧也没有端口可用。这里用真实 AgentRuntime + 真实子代理工厂验证这两个方向，
// 并捕获第二轮模型请求确认搜索结果确实回到了模型。
//
// 记忆提取代理的端口接线不在此文件验证：生产路径在 runMemoryAgentLoop 里按
// sideEffectScope === "network" 先拒绝 WebSearch，执行器根本不会到达端口。这里用真实
// 循环锁定该策略（端口未被调用），这是策略单测，不是「记忆代理能搜索」的执行证明。

test("general-purpose 子代理：声明 WebSearch、执行落到父端口，搜索结果回到模型", async (t) => {
  const workingDirectory = await createIsolatedWorkspace(t);
  const port = createStubPort(() => ACTIVE_PROVIDER);
  const harness = await createParentHarness(t, { port, workingDirectory });

  await runSubagent(harness, "general-purpose", workingDirectory);

  assert.equal(harness.host.requests.length, 2, "应有一轮工具调用与一轮收尾模型请求");
  const firstRequest = harness.host.requests[0];
  const secondRequest = harness.host.requests[1];
  assert.ok(firstRequest);
  assert.ok(secondRequest);
  assert.ok(
    firstRequest.toolNames.includes("WebSearch"),
    `子代理模型请求必须声明 WebSearch，实际：${firstRequest.toolNames.join(",")}`,
  );
  assert.ok(secondRequest.toolNames.includes("WebSearch"));

  const call = port.calls[0];
  assert.ok(call, "子代理的 WebSearch 调用必须落到父会话的同一个端口");
  assert.equal(port.calls.length, 1);
  assert.strictEqual(call.provider, ACTIVE_PROVIDER, "执行必须复用端口解析出的创建时激活源");
  assert.equal(call.input.query, WEBSEARCH_QUERY);
  assert.equal(call.output.results[0]?.url, STUB_RESULT_URL);

  const toolResult = secondRequest.toolResults.find((result) => result.toolName === "WebSearch");
  assert.ok(toolResult, "第二轮模型请求必须带上 WebSearch 的工具结果");
  assert.equal(toolResult.isError, false);
  assert.match(
    toolResult.content,
    /https:\/\/example\.test\/stub/u,
    "搜索结果必须真的回到模型上下文",
  );
});

test("Explore 子代理：同样借用父端口声明并执行 WebSearch", async (t) => {
  const workingDirectory = await createIsolatedWorkspace(t);
  const port = createStubPort(() => ACTIVE_PROVIDER);
  const harness = await createParentHarness(t, { port, workingDirectory });

  await runSubagent(harness, "Explore", workingDirectory);

  const firstRequest = harness.host.requests[0];
  assert.ok(firstRequest, "Explore 子代理必须真的发起过模型请求");
  assert.ok(
    firstRequest.toolNames.includes("WebSearch"),
    `Explore 模型请求必须声明 WebSearch，实际：${firstRequest.toolNames.join(",")}`,
  );
  const call = port.calls[0];
  assert.ok(call, "Explore 的 WebSearch 调用必须落到父端口");
  assert.equal(port.calls.length, 1);
  assert.strictEqual(call.provider, ACTIVE_PROVIDER);
  assert.equal(call.input.query, WEBSEARCH_QUERY);
});

test("profile 显式禁用 WebSearch 时子代理不声明也不调用", async (t) => {
  const workingDirectory = await createIsolatedWorkspace(t);
  const port = createStubPort(() => ACTIVE_PROVIDER);
  const restrictedProfile: AgentProfile = {
    name: "restricted",
    description: "只读受限子代理",
    source: "user",
    systemPrompt: "restricted",
    tools: ["*"],
    disallowedTools: ["WebSearch"],
  };
  const harness = await createParentHarness(t, {
    port,
    profiles: [restrictedProfile],
    workingDirectory,
  });

  await runSubagent(harness, "restricted", workingDirectory);

  const firstRequest = harness.host.requests[0];
  assert.ok(firstRequest, "受限子代理必须真的发起过模型请求");
  assert.equal(
    firstRequest.toolNames.includes("WebSearch"),
    false,
    "profile 禁用 WebSearch 时不得向模型声明",
  );
  assert.equal(port.calls.length, 0, "被禁用的工具不得被调用");
});

test("自定义 profile 只给 Read 时子代理不声明 WebSearch", async (t) => {
  const workingDirectory = await createIsolatedWorkspace(t);
  const port = createStubPort(() => ACTIVE_PROVIDER);
  const readOnlyProfile: AgentProfile = {
    name: "read-only",
    description: "仅 Read 的自定义子代理",
    source: "user",
    systemPrompt: "read-only",
    tools: ["Read"],
  };
  const harness = await createParentHarness(t, {
    port,
    profiles: [readOnlyProfile],
    workingDirectory,
  });

  await runSubagent(harness, "read-only", workingDirectory);

  const firstRequest = harness.host.requests[0];
  assert.ok(firstRequest, "自定义子代理必须真的发起过模型请求");
  assert.ok(
    firstRequest.toolNames.includes("Read"),
    `自定义 profile 的工具范围必须生效，实际：${firstRequest.toolNames.join(",")}`,
  );
  assert.equal(firstRequest.toolNames.includes("WebSearch"), false);
  assert.equal(port.calls.length, 0);
});

test("父会话没有 WebSearch 端口时子代理不声明 WebSearch（fail-closed）", async (t) => {
  const workingDirectory = await createIsolatedWorkspace(t);
  const harness = await createParentHarness(t, { workingDirectory });

  await runSubagent(harness, "general-purpose", workingDirectory);

  const firstRequest = harness.host.requests[0];
  assert.ok(firstRequest, "子代理必须真的发起过模型请求");
  assert.equal(
    firstRequest.toolNames.includes("WebSearch"),
    false,
    "父端口缺席时不得向模型声明 WebSearch",
  );
});

test("父端口冻结创建时策略：之后改变外部 latest policy，派生仍用创建时快照", async (t) => {
  const workingDirectory = await createIsolatedWorkspace(t);
  const policy: { latest: ActiveWebSearchProvider | undefined } = { latest: ACTIVE_PROVIDER };
  const port = createSnapshotStubPort(policy);
  const harness = await createParentHarness(t, { port, workingDirectory });

  // 父会话创建后外部策略翻转：派生运行时不得重新读取它。
  policy.latest = OTHER_PROVIDER;

  await runSubagent(harness, "general-purpose", workingDirectory);

  const firstRequest = harness.host.requests[0];
  assert.ok(firstRequest, "子代理必须真的发起过模型请求");
  assert.ok(firstRequest.toolNames.includes("WebSearch"));
  const call = port.calls[0];
  assert.ok(call, "派生运行时必须继续使用父会话借用来的端口");
  assert.strictEqual(call.provider, ACTIVE_PROVIDER, "必须沿用创建时快照，而不是外部 latest");
  assert.notStrictEqual(policy.latest, ACTIVE_PROVIDER, "外部 latest 确实已经变化");
  assert.equal(call.input.query, WEBSEARCH_QUERY);
});

test("记忆提取代理：策略拒绝 WebSearch 且端口不会被调用（策略单测）", async (t) => {
  const workingDirectory = await createIsolatedWorkspace(t);
  const port = createStubPort(() => ACTIVE_PROVIDER);
  const harness = await createParentHarness(t, { port, workingDirectory });
  const host: FakeModelHost = { requests: [], webSearchCalls: 0 };
  const model = createFakeModel(PARENT_SELECTION, host);

  const context = captureProjectMemoryAgentContext(harness.internal, {
    memoryRoot: workingDirectory,
    model,
    operation: ModelApiOperation.ProjectMemoryExtract,
    traceContext: { traceId: createTraceId() },
  });
  assert.ok(
    context.tools.some((tool) => tool.name === "WebSearch"),
    "记忆代理继承父工具目录，WebSearch 应当在其中",
  );

  const executed: string[] = [];
  await runMemoryAgentLoop({
    maxTurns: 2,
    messages: [{ role: "user", content: "extract project memory" }],
    model,
    rootDir: workingDirectory,
    tools: context.tools,
    workingDirectory,
    workspaceRoot: workingDirectory,
    executeTool: async (toolCall) => {
      executed.push(toolCall.name);
      throw new Error(
        `memory agent policy must deny WebSearch before execution: ${toolCall.name}`,
      );
    },
  });

  assert.deepEqual(executed, [], "策略拒绝必须发生在工具执行器之前");
  assert.equal(port.calls.length, 0, "被策略拒绝的 WebSearch 不得触达父端口");

  assert.equal(host.requests.length, 2, "应有一轮工具拒绝与一轮收尾模型请求");
  const secondRequest = host.requests[1];
  assert.ok(secondRequest, "拒绝结果要进入下一轮模型请求");
  const toolResult = secondRequest.toolResults.find((result) => result.toolName === "WebSearch");
  assert.ok(toolResult, "第二轮请求必须带上 WebSearch 的策略拒绝结果");
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content, /only Read, Grep, Glob/u);
});
