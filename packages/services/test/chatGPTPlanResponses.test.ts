import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatGPTPlanRequest,
  validateChatGPTPlanStream,
} from "../src/chatgpt-plan/responses.js";

test("订阅请求只发送白名单字段，强制 streaming/store，工具置于 namespace", () => {
  const body = buildChatGPTPlanRequest({
    model: "test-model",
    input: [
      { role: "system", content: "rules" },
      { role: "user", content: "hi" },
    ],
    stream: false,
    store: true,
    previous_response_id: "old",
    temperature: 1,
    prompt_cache_retention: "24h",
    tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
    headers: { Authorization: "untrusted" },
    max_output_tokens: 100,
  });
  assert.deepEqual(body, {
    model: "test-model",
    input: [
      { role: "developer", content: "rules" },
      { role: "user", content: "hi" },
    ],
    store: false,
    stream: true,
    tools: [
      {
        type: "namespace",
        name: "ycode",
        tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
      },
    ],
  });
});

async function consume(frames: string[], completed = true) {
  const bytes = new TextEncoder().encode(
    frames.join("") +
      (completed
        ? 'data: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n'
        : ""),
  );
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
      c.close();
    },
  });
  return new Response(validateChatGPTPlanStream(stream)).text();
}

test("SSE 跨字节 UTF-8、CRLF 与 completed-only 成功", async () => {
  const frame = 'data: {"type":"response.output_text.delta","delta":"你好"}\r\n\r\n';
  assert.match(await consume([frame]), /你好/);
  await assert.rejects(consume([frame], false), /stream_interrupted/);
  await assert.rejects(
    consume(['data: {"type":"response.incomplete"}\n\n']),
    /response_incomplete/,
  );
  await assert.rejects(
    consume([
      'data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n',
    ]),
    /subscription_sharing_usage_limit_exceeded/,
  );
});

test("不接受任意 hosted 工具或非数组 history", () => {
  assert.throws(() => buildChatGPTPlanRequest({ model: "x", input: "hello" }));
  assert.throws(() =>
    buildChatGPTPlanRequest({ model: "x", input: [], tools: [{ type: "tool_search" }] }),
  );
});

test("工具 final 事件在 completed 前不出 Host，随后失败不能触发预执行", async () => {
  let send!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      send = c;
    },
  });
  const reader = validateChatGPTPlanStream(source, new Set(["read_file"])).getReader();
  const item = {
    type: "function_call",
    id: "item",
    call_id: "call",
    name: "read_file",
    arguments: "{}",
    status: "completed",
  };
  send.enqueue(
    encoder.encode(
      [
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.failed",
          response: { error: { code: "subscription_sharing_usage_limit_exceeded" } },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    ),
  );
  send.close();
  await assert.rejects(reader.read(), /subscription_sharing_usage_limit_exceeded/);
});

test("历史引用和音视频输入不应作为支持的订阅请求发送", () => {
  assert.throws(() =>
    buildChatGPTPlanRequest({ model: "x", input: [{ type: "item_reference", id: "old" }] }),
  );
  assert.throws(() =>
    buildChatGPTPlanRequest({
      model: "x",
      input: [{ role: "user", content: [{ type: "input_audio", data: "unsupported" }] }],
    }),
  );
});
