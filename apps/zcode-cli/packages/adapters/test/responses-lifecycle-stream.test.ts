import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAI } from "@ai-sdk/openai";
import { createModelId, createModelProviderId } from "@zcode/contracts";
import { runStreamText } from "../src/model/runner-stream.js";
import { defaultRuntime, type ResolvedAiSdkModel } from "../src/model/runner-runtime.js";

const RESPONSE_ID = "resp_fixture";
const MESSAGE_ID = "msg_fixture";
const MODEL_ID = "gpt-fixture";
const TEST_TIMEOUT_MS = 5_000;

function createResponsesFixture(signal: AbortSignal) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let requestCount = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const send = (event: Record<string, unknown>) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };
  const provider = createOpenAI({
    apiKey: "fixture-only",
    fetch: async (_url, init) => {
      requestCount += 1;
      assert.equal(JSON.parse(String(init?.body)).stream, true);
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const resolved: ResolvedAiSdkModel = {
    model: provider.responses(MODEL_ID),
    modelId: createModelId(MODEL_ID),
    providerId: createModelProviderId("fixture"),
    providerKind: "openai",
    providerOptions: { apiFormat: "openai-responses" },
    properties: {
      contextWindow: 32_000,
      requiresMfjsToolSchema: false,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsMidConversationSystem: true,
    },
  };
  const stream = runStreamText({
    env: {},
    modelIoRecordingEnabled: false,
    modelIoFullRetentionEnabled: false,
    request: {
      abortSignal: signal,
      messages: [{ role: "user", content: "fixture prompt" }],
      observeResponsesLifecycle: true,
    },
    resolved,
    resolveModel: () => resolved,
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, backoffFactor: 1, jitter: false },
    runtime: defaultRuntime,
    streamIdleTimeoutMs: TEST_TIMEOUT_MS,
  });

  send({
    type: "response.created",
    response: { id: RESPONSE_ID, model: MODEL_ID, created_at: 1 },
  });

  return {
    send,
    stream,
    requestCount: () => requestCount,
    sendTextAndFinish() {
      const item = { type: "message", id: MESSAGE_ID };
      send({ type: "response.output_item.added", output_index: 0, item });
      send({ type: "response.output_text.delta", item_id: MESSAGE_ID, delta: "hello" });
      send({ type: "response.output_item.done", output_index: 0, item });
      send({
        type: "response.completed",
        response: { id: RESPONSE_ID, usage: { input_tokens: 2, output_tokens: 1 } },
      });
      controller.close();
    },
  };
}

test(
  "真实 Responses SSE 在正文尚未发送时就交付思考阶段",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = createResponsesFixture(t.signal);
    fixture.send({ type: "response.in_progress", response: { id: RESPONSE_ID } });

    // 先等待真实 SDK/adapter 交付阶段，再放行正文；旧缓冲逻辑会在这里阻塞而超时。
    const first = await fixture.stream.next();
    assert.equal(first.done, false);
    assert.equal(first.value?.type, "reasoning_phase_start");
    assert.equal(first.value?.responseId, RESPONSE_ID);
    assert.equal(fixture.requestCount(), 1);

    fixture.sendTextAndFinish();
    const rest = await Array.fromAsync(fixture.stream);
    assert.equal(fixture.requestCount(), 1);
    assert.equal(rest.filter((event) => event.type === "reasoning_phase_start").length, 0);
    const phaseEndIndex = rest.findIndex((event) => event.type === "reasoning_phase_end");
    const textStartIndex = rest.findIndex((event) => event.type === "text_start");
    assert.ok(phaseEndIndex >= 0 && phaseEndIndex < textStartIndex);
    assert.equal(rest[phaseEndIndex]?.phaseEndReason, "text");
    assert.equal(
      rest
        .filter((event) => event.type === "text_delta")
        .map((event) => event.text)
        .join(""),
      "hello",
    );
    assert.equal(rest.at(-1)?.type, "finish");
  },
);

test(
  "Responses 兼容端点缺少 in_progress 时不凭 created 或正文生成思考阶段",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = createResponsesFixture(t.signal);
    fixture.sendTextAndFinish();

    const events = await Array.fromAsync(fixture.stream);
    assert.equal(fixture.requestCount(), 1);
    assert.equal(
      events.some((event) => event.type === "reasoning_phase_start"),
      false,
    );
    assert.equal(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.text)
        .join(""),
      "hello",
    );
  },
);
