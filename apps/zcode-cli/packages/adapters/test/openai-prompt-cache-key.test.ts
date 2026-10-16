import assert from "node:assert/strict";
import test from "node:test";
import {
  createGenerateTextOptions,
  createStreamTextOptions,
} from "../src/model/runner-options.js";
import { resolveOpenAiPromptCacheKey } from "../src/model/openai-request-cache-key.js";

// spec: docs/specs/openai-prompt-cache-key.md
// OpenAI 前缀缓存按服务端实例存放，注入会话级 prompt_cache_key 做缓存路由亲和；
// 实测缺失该字段时同会话同前缀请求命中率随机跳变（~12%–55%）。

const SESSION_ID = "sess_9a8a89ff-5b56-4156-9de9-030c8ae1474c";
const SUBAGENT_SESSION_ID = "sess_subagent_agent_b8d6a3dd-450f-4fc8-b52c-ac56373f49ec";

function baseRequest(): Parameters<typeof createStreamTextOptions>[0]["request"] {
  return {
    messages: [],
  } as unknown as Parameters<typeof createStreamTextOptions>[0]["request"];
}

function baseResolved(
  providerKind: "openai" | "openai-compatible" | "anthropic",
  providerOptions?: Record<string, unknown>,
): Parameters<typeof createStreamTextOptions>[0]["resolved"] {
  return {
    providerKind,
    modelId: "gpt-6.1-sol",
    properties: {},
    ...(providerOptions ? { providerOptions } : {}),
  } as unknown as Parameters<typeof createStreamTextOptions>[0]["resolved"];
}

test("openai-responses 请求注入会话级 promptCacheKey", () => {
  const key = resolveOpenAiPromptCacheKey({
    providerKind: "openai",
    sessionId: SESSION_ID,
  });
  assert.equal(key, "9a8a89ff-5b56-4156-9de9-030c8ae1474c");

  for (const create of [createGenerateTextOptions, createStreamTextOptions]) {
    const options = create({
      openAiPromptCacheKey: key,
      includeModelIO: false,
      request: baseRequest(),
      resolved: baseResolved("openai"),
      statusContext: { traceId: "trace" } as Parameters<typeof create>[0]["statusContext"],
    });
    assert.equal(
      (options.providerOptions?.openai as Record<string, unknown> | undefined)?.promptCacheKey,
      "9a8a89ff-5b56-4156-9de9-030c8ae1474c",
    );
  }
});

test("同一会话连续请求的 promptCacheKey 稳定；子代理用子会话 ID", () => {
  const first = resolveOpenAiPromptCacheKey({
    providerKind: "openai",
    sessionId: SESSION_ID,
  });
  const second = resolveOpenAiPromptCacheKey({
    providerKind: "openai",
    sessionId: SESSION_ID,
  });
  assert.equal(first, second);

  const subagent = resolveOpenAiPromptCacheKey({
    providerKind: "openai",
    sessionId: SUBAGENT_SESSION_ID,
  });
  // 归一化剥掉内部前缀后仍与父会话 key 不同，天然隔离缓存路由。
  assert.notEqual(subagent, first);
  assert.ok(subagent && subagent.includes("b8d6a3dd"));
});

test("openai-compatible 与 anthropic 不注入", () => {
  assert.equal(
    resolveOpenAiPromptCacheKey({ providerKind: "openai-compatible", sessionId: SESSION_ID }),
    undefined,
  );
  assert.equal(
    resolveOpenAiPromptCacheKey({ providerKind: "anthropic", sessionId: SESSION_ID }),
    undefined,
  );

  const options = createStreamTextOptions({
    openAiPromptCacheKey: undefined,
    includeModelIO: false,
    request: baseRequest(),
    resolved: baseResolved("openai-compatible"),
    statusContext: { traceId: "trace" } as Parameters<typeof createStreamTextOptions>[0]["statusContext"],
  });
  assert.equal(options.providerOptions?.openai, undefined);
});

test("显式配置的 promptCacheKey 不被覆盖", () => {
  const options = createStreamTextOptions({
    openAiPromptCacheKey: "9a8a89ff-5b56-4156-9de9-030c8ae1474c",
    includeModelIO: false,
    request: baseRequest(),
    resolved: baseResolved("openai", { openai: { promptCacheKey: "user-explicit-key" } }),
    statusContext: { traceId: "trace" } as Parameters<typeof createStreamTextOptions>[0]["statusContext"],
  });
  assert.equal(
    (options.providerOptions?.openai as Record<string, unknown>).promptCacheKey,
    "user-explicit-key",
  );
});

test("无会话 ID 不注入", () => {
  assert.equal(resolveOpenAiPromptCacheKey({ providerKind: "openai" }), undefined);
});
