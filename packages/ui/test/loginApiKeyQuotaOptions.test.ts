import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderSettingsTemplateView } from "@zcode/provider";
import {
  buildLoginApiKeySkipSettings,
  resolveLoginApiKeyDefaultTemplateId,
  resolveLoginApiKeyProviderOptions,
} from "@/login/LoginApiKeyForm.helpers.js";

function makeTemplate(
  templateId: string,
  accessType = "api-key",
): ProviderSettingsTemplateView {
  return {
    templateId,
    templateNameMap: { "zh-CN": templateId, "en-US": templateId },
    config: {
      access: { type: accessType, apiKeyManagementUrl: `https://example.com/${templateId}` },
      api: { type: "anthropic-messages", baseUrl: "https://example.com" },
      builtinModelIds: [],
      logo: { type: "builtin", key: templateId },
    },
  } as unknown as ProviderSettingsTemplateView;
}

const ALL_QUOTA_TEMPLATES = [
  "zai-api",
  "bigmodel-api",
  "zai-standard-api",
  "bigmodel-standard-api",
  "deepseek",
  "minimax-token-plan",
  "openrouter",
  "opencode-go-chat",
  "opencode-go-messages",
  "opencode-go-responses",
  "opencode-zen-chat",
  "opencode-zen-messages",
  "opencode-zen-responses",
];

test("引导下拉列出单 Key 可建的 13 个模板（含 OpenCode Go/Zen）", () => {
  const options = resolveLoginApiKeyProviderOptions([
    ...ALL_QUOTA_TEMPLATES.map((id) => makeTemplate(id)),
    makeTemplate("minimax"),
    makeTemplate("moonshot-kimi"),
    makeTemplate("openai"),
  ]);
  assert.deepEqual(
    options.map((option) => option.templateId),
    ALL_QUOTA_TEMPLATES,
  );
});

test("智谱 Coding Plan 排在标准 API 之前，DeepSeek 等随后", () => {
  const options = resolveLoginApiKeyProviderOptions(
    ["openrouter", "deepseek", "zai-standard-api", "bigmodel-api"].map((id) => makeTemplate(id)),
  );
  assert.deepEqual(
    options.map((option) => option.templateId),
    ["bigmodel-api", "zai-standard-api", "deepseek", "openrouter"],
  );
});

test("中文默认 BigModel、英文默认 Z.ai，缺失时取第一项", () => {
  const ids = ["deepseek", "openrouter", "bigmodel-api", "zai-api"];
  assert.equal(resolveLoginApiKeyDefaultTemplateId("zh-CN", ids), "bigmodel-api");
  assert.equal(resolveLoginApiKeyDefaultTemplateId("en-US", ids), "zai-api");
  assert.equal(
    resolveLoginApiKeyDefaultTemplateId("zh-CN", ["deepseek", "openrouter"]),
    "deepseek",
  );
  assert.equal(resolveLoginApiKeyDefaultTemplateId("zh-CN", []), null);
});

test("智谱模板跳过写域名归属，非智谱模板跳过不写", () => {
  assert.equal(buildLoginApiKeySkipSettings("bigmodel-api", 1).providerFamilyDomain, "bigmodel");
  assert.equal(buildLoginApiKeySkipSettings("zai-standard-api", 1).providerFamilyDomain, "zai");
  assert.equal(
    "providerFamilyDomain" in buildLoginApiKeySkipSettings("deepseek", 1),
    false,
  );
});
