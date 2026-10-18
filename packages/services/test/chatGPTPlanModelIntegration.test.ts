import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatGPTPlanStore } from "../src/chatgpt-plan/store.js";
import { ChatGPTPlanOwner } from "../src/chatgpt-plan/service.js";
import { ChatGPTPlanStreamBridge } from "../src/chatgpt-plan/streamBridge.js";
import { AiSdkModelExecution } from "../../../apps/zcode-cli/packages/adapters/src/model/model-execution.js";
import { createChatGPTPlanTransport } from "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/chatgpt-plan-transport.js";
import { createRegistryProviderConfig, parseProviderConfig } from "@zcode/provider";

const usage = {
  input_tokens: 40,
  input_tokens_details: { cached_tokens: 16 },
  output_tokens: 6,
  output_tokens_details: { reasoning_tokens: 0 },
};

test("订阅 Provider 不能使用 API Key，也不能绕过缺失 Host transport 的环境", () => {
  const execution = new AiSdkModelExecution();
  const options = {
    providerId: "openai-chatgpt-plan",
    modelId: "test-model",
    supportsJsonSchemaOutput: false,
    optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
  };
  for (const access of [
    { type: "api-key", apiKey: "test-paid-key" },
    { type: "chatgpt-plan", accountId: "test-account" },
  ]) {
    const config = createRegistryProviderConfig(
      parseProviderConfig({
        group: "standard-personal",
        access,
        api: { type: "openai-responses", baseUrl: "https://api.openai.com/v1" },
      }),
    );
    assert.ok(config.ok);
    assert.throws(
      () => execution.bindModel({ ...options, providerConfig: config.config }),
      /cannot use API Key|requires a local Host/,
    );
  }
});
function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("真实 AI SDK + stdio bridge + Host：分段函数参数、多工具结果、两轮完整历史与缓存 usage", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ycode-chatgpt-model-test-"));
  const store = new ChatGPTPlanStore(join(dir, "private.enc"));
  await store.update((state) => {
    state.activeAccountId = "test-account";
    state.accounts.push({
      id: "test-account",
      clientId: "test-client",
      subject: "test-subject",
      label: "Test",
      generation: 0,
      tokens: {
        accessToken: "test-access-secret",
        idToken: "test-id-secret",
        scopes: ["chatgpt.tokens.use.direct"],
        expiresAt: Date.now() + 3600_000,
      },
      models: [{ slug: "test-model", displayName: "Test" }],
    });
  });
  const requests: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal("previous_response_id" in body, false);
    assert.equal("prompt_cache_retention" in body, false);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-access-secret");
    const created = {
      type: "response.created",
      response: { id: `response-${requests.length}`, model: "test-model", created_at: 1 },
    };
    if (requests.length === 1) {
      const items = ["read_file", "list_files"].map((name, i) => ({
        type: "function_call",
        id: `item-${i}`,
        call_id: `call-${i}`,
        name,
        namespace: "ycode",
        arguments: '{"path":"src"}',
        status: "completed",
      }));
      return sse([
        created,
        ...items.flatMap((item, i) => [
          {
            type: "response.output_item.added",
            output_index: i,
            item: { ...item, arguments: "", status: "in_progress" },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: i,
            item_id: item.id,
            delta: '{"path":',
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: i,
            item_id: item.id,
            delta: '"src"}',
          },
          { type: "response.output_item.done", output_index: i, item },
        ]),
        {
          type: "response.completed",
          response: { id: "response-1", status: "completed", output: items, usage },
        },
      ]);
    }
    assert.ok(
      body.input.some(
        (item: { type: string; call_id?: string }) =>
          item.type === "function_call_output" && item.call_id === "call-0",
      ),
    );
    assert.ok(
      body.input.some(
        (item: { type: string; call_id?: string }) =>
          item.type === "function_call_output" && item.call_id === "call-1",
      ),
    );
    assert.equal(
      body.input.some((item: { type: string }) => item.type === "item_reference"),
      false,
    );
    return sse([
      created,
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg-2" },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg-2",
        output_index: 0,
        content_index: 0,
        delta: "Done",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "msg-2" },
      },
      { type: "response.completed", response: { status: "completed", usage, output: [] } },
    ]);
  };
  const owner = new ChatGPTPlanOwner({ store, fetch: fetchImpl, publish: async () => {} });
  const bridge = new ChatGPTPlanStreamBridge(owner, fetchImpl);
  t.after(async () => {
    bridge.dispose();
    await owner.disposeAndWait();
    await rm(dir, { recursive: true, force: true });
  });
  const transport = createChatGPTPlanTransport({
    async requestClient(_method, params, schema) {
      return schema.parse(await bridge.handle(params as never));
    },
  });
  const execution = new AiSdkModelExecution({ chatGPTPlanTransport: transport });
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "chatgpt-plan", accountId: "test-account" },
      api: {
        type: "openai-responses",
        baseUrl: "https://untrusted.invalid",
        headers: { Authorization: "untrusted" },
      },
    }),
  );
  assert.ok(provider.ok);
  const resolved = execution.bindModel({
    providerId: "openai-chatgpt-plan",
    modelId: "test-model",
    providerConfig: provider.config,
    supportsJsonSchemaOutput: false,
    optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
  }).resolved;
  const model = resolved.model;
  assert.notEqual(typeof model, "string");
  if (typeof model === "string" || model.specificationVersion !== "v3")
    throw new Error("Expected v3 model");
  const prompt = [
    { role: "user" as const, content: [{ type: "text" as const, text: "Read and list files" }] },
  ];
  const tools = ["read_file", "list_files"].map((name) => ({
    type: "function" as const,
    name,
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  }));
  const first = await model.doStream({
    prompt,
    tools,
    providerOptions: { openai: { store: true, previousResponseId: "must-be-removed" } },
  });
  const chunks = [];
  for await (const chunk of first.stream) {
    if (chunk.type === "error") throw chunk.error;
    chunks.push(chunk);
  }
  const calls = chunks.filter((chunk) => chunk.type === "tool-call");
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0]!.input), { path: "src" });
  const finish = chunks.find((chunk) => chunk.type === "finish");
  assert.equal(finish?.usage.inputTokens.cacheRead, 16);
  // Dispatcher 的执行边界在调用方；adapter 只产出模型调用事实，结果通过相同 call ID 返回历史。
  const second = await model.doStream({
    prompt: [
      ...prompt,
      {
        role: "assistant",
        content: calls.map((call) => ({
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: JSON.parse(call.input),
        })),
      },
      {
        role: "tool",
        content: calls.map((call) => ({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: "text", value: "fixture file contents" },
        })),
      },
    ],
    tools,
  });
  let text = "";
  for await (const chunk of second.stream) {
    if (chunk.type === "error") throw chunk.error;
    if (chunk.type === "text-delta") text += chunk.delta;
  }
  assert.equal(text, "Done");
  assert.equal(requests.length, 2);
});
