import assert from "node:assert/strict";
import test from "node:test";
import { resolvePendingProviderDraftSave } from "../src/settings/model-provider-section/ProviderDraftSave.js";
import type { ProviderSettingsFormProvider } from "../src/lib/providerSettingsFormTypes.js";

// CLI Proxy 表单分支：protocolOnly 模式下只允许协议写回，
// endpoint（baseURL）与 apiKey 的草稿变更一律丢弃。

function cliproxyProvider(): ProviderSettingsFormProvider {
  return {
    providerId: "personal-1",
    templateId: "cliproxy-codex",
    providerName: "Codex",
    enabled: true,
    executable: true,
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "internal-key" },
      api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:8317/v1" },
    },
    personalConfig: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "internal-key" },
      api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:8317/v1" },
    },
    models: [],
  } as unknown as ProviderSettingsFormProvider;
}

test("protocolOnly：协议变更写回", () => {
  const next = resolvePendingProviderDraftSave({
    provider: cliproxyProvider(),
    draft: {
      nameValue: "Codex",
      apiFormat: "anthropic-messages",
      baseUrlValue: "http://127.0.0.1:8317/v1",
      apiKeyValue: "internal-key",
    },
    protocolOnly: true,
    now: Date.now,
  });
  assert.ok(next);
  assert.equal(next.config.api?.type, "anthropic-messages");
  assert.equal(next.config.api?.baseUrl, "http://127.0.0.1:8317/v1");
});

test("protocolOnly：baseURL 草稿变更被丢弃（运行时回填才是唯一写路径）", () => {
  const next = resolvePendingProviderDraftSave({
    provider: cliproxyProvider(),
    draft: {
      nameValue: "Codex",
      apiFormat: "openai-chat-completions",
      baseUrlValue: "http://127.0.0.1:9999/v1",
      apiKeyValue: "internal-key",
    },
    protocolOnly: true,
    now: Date.now,
  });
  assert.equal(next, null);
});

test("protocolOnly：apiKey 草稿变更被丢弃（key 由运行时生成落盘）", () => {
  const next = resolvePendingProviderDraftSave({
    provider: cliproxyProvider(),
    draft: {
      nameValue: "Codex",
      apiFormat: "openai-chat-completions",
      baseUrlValue: "http://127.0.0.1:8317/v1",
      apiKeyValue: "user-typed-key",
    },
    protocolOnly: true,
    now: Date.now,
  });
  assert.equal(next, null);
});

test("普通分支不受影响：baseURL 仍可写回", () => {
  const next = resolvePendingProviderDraftSave({
    provider: { ...cliproxyProvider(), templateId: "openai" },
    draft: {
      nameValue: "OpenAI",
      apiFormat: "openai-chat-completions",
      baseUrlValue: "https://api.example.com/v1",
      apiKeyValue: "internal-key",
    },
    now: Date.now,
  });
  assert.ok(next);
  assert.equal(next.config.api?.baseUrl, "https://api.example.com/v1");
});
