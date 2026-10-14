import assert from "node:assert/strict";
import test from "node:test";
import { resolveCliProxyForcedApiType } from "../src/resolver.js";

// CLI Proxy 强制 Responses 协议（用户拍板）：代理侧无需做协议翻译、更稳定。
// 覆盖发生在 Registry 组装（请求事实），不改存储配置，已建条目同样生效。

test("cliproxy-* 模板强制 openai-responses", () => {
  assert.equal(resolveCliProxyForcedApiType("cliproxy-codex"), "openai-responses");
  assert.equal(resolveCliProxyForcedApiType("cliproxy-future"), "openai-responses");
});

test("非代理模板不强制", () => {
  assert.equal(resolveCliProxyForcedApiType("openai"), null);
  assert.equal(resolveCliProxyForcedApiType("opencode-go-chat"), null);
  assert.equal(resolveCliProxyForcedApiType(null), null);
  assert.equal(resolveCliProxyForcedApiType(undefined), null);
});

// 端点投影回归（根因：真机 + 脚本复现 2026-10-14）：Registry 要求 provider 配置完整，
// access.apiKey 缺失时 cliproxy provider 被整体排除出模型选择器——设置页卡片可见、
// 模型却永远不出现。数据面 api-key 由 Host 从 data.key 投影写入（见
// resolveCliProxyProviderEndpointPatch），这里锁定 Resolver 两侧行为。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderTemplate,
  ProviderTemplateMap,
} from "../src/index.js";

function builtinModelRules(): ModelConfigRules {
  // 复用仓库内置规则全集（五类都进，匹配/覆盖顺序与线上一致），不在测试里手抄 schema。
  const raw = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../config/provider/zcode-builtin.json", import.meta.url)),
      "utf8",
    ),
  ) as {
    config: {
      modelConfigRules: {
        modelRules: Array<{ modelMatch: string; config: Record<string, unknown> }>;
        modelApiRules: Array<{
          modelMatch: string;
          apiTypeMatch: string;
          config: Record<string, unknown>;
        }>;
        providerSiteRules: Array<{
          modelMatch: string;
          apiTypeMatch?: string;
          baseUrlMatch: string;
          config: Record<string, unknown>;
        }>;
        templateModelRules: Array<{
          templateId: string;
          modelId: string;
          config: Record<string, unknown>;
        }>;
        builtinProviderModelRules: Array<{
          providerId: string;
          modelId: string;
          config: Record<string, unknown>;
        }>;
      };
    };
  };
  const m = raw.config.modelConfigRules;
  return new ModelConfigRules([
    ...m.modelRules.map((rule) => ({
      type: "model" as const,
      modelMatch: rule.modelMatch,
      config: ModelConfig.fromData(rule.config),
    })),
    ...m.modelApiRules.map((rule) => ({
      type: "model-api" as const,
      modelMatch: rule.modelMatch,
      apiTypeMatch: rule.apiTypeMatch,
      config: ModelConfig.fromData(rule.config),
    })),
    ...m.providerSiteRules.map((rule) => ({
      type: "provider-site" as const,
      modelMatch: rule.modelMatch,
      apiTypeMatch: rule.apiTypeMatch,
      baseUrlMatch: rule.baseUrlMatch,
      config: ModelConfig.fromData(rule.config),
    })),
    ...m.templateModelRules.map((rule) => ({
      type: "template-model" as const,
      templateId: rule.templateId,
      modelId: rule.modelId,
      config: ModelConfig.fromData(rule.config),
    })),
    ...m.builtinProviderModelRules.map((rule) => ({
      type: "provider-model" as const,
      providerId: rule.providerId,
      modelId: rule.modelId,
      config: ModelConfig.fromData(rule.config),
    })),
  ]);
}

function resolveCliproxy(personalConfig: ProviderConfig) {
  const templates = new ProviderTemplateMap([
    [
      "cliproxy-codex",
      new ProviderTemplate({
        templateId: "cliproxy-codex",
        templateNameMap: { "en-US": "Codex" },
        config: new ProviderConfig({
          access: new ApiKeyAccessConfig({
            type: "api-key",
            apiKeyManagementUrl: "https://chatgpt.com/codex",
          }),
          api: new ProviderApiConfig({
            type: "openai-responses",
            baseUrl: "http://127.0.0.1:8317/v1",
          }),
        }),
      }),
    ],
  ]);
  const personal = new ProviderConfigMap([
    {
      providerId: "cliproxy-codex",
      templateId: "cliproxy-codex",
      providerName: "Codex",
      config: personalConfig,
    },
  ]);
  return new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: ProviderConfigMap.empty(),
    zcodeBuiltinProviderTemplates: templates,
    personalProviders: personal,
    zcodeBuiltinModelRules: builtinModelRules(),
    personalModels: ModelConfigRules.empty(),
    accountProviders: new ProviderConfigMap(),
  });
}

test("缺 access.apiKey 的 cliproxy provider 被排除出 Registry（根因回归）", () => {
  const resolution = resolveCliproxy(
    new ProviderConfig({
      group: "standard-personal",
      personalModelIds: ["gpt-5.5"],
      modelOrder: ["gpt-5.5"],
    }),
  );
  const resolved = resolution.resolvedProviders.find((p) => p.providerId === "cliproxy-codex");
  assert.ok(resolved);
  const issue = resolved.providerIssues.find(
    (candidate) =>
      candidate.code === "required-field-missing" &&
      candidate.path.join(".").endsWith("access.apiKey"),
  );
  assert.ok(issue, "缺少 access.apiKey 必须产生 required-field-missing");
  assert.equal(
    resolution.registryProviders.some((p) => p.providerId === "cliproxy-codex"),
    false,
    "配置不完整的 provider 不得进入模型选择器",
  );
});

test("投影 access.apiKey 后 cliproxy provider 进入 Registry", () => {
  const resolution = resolveCliproxy(
    new ProviderConfig({
      group: "standard-personal",
      access: new ApiKeyAccessConfig({ type: "api-key", apiKey: "projected-data-key" }),
      personalModelIds: ["gpt-5.5"],
      modelOrder: ["gpt-5.5"],
    }),
  );
  const registered = resolution.registryProviders.find(
    (p) => p.providerId === "cliproxy-codex",
  );
  assert.ok(registered, "投影后 provider 必须进入模型选择器");
  assert.deepEqual(registered.models.map((m) => m.modelId), ["gpt-5.5"]);
});

test("GPT 6 系列（sol/1-sol/luna）解析到分级思考档位而非兜底关闭/开启", () => {
  // 回归（用户真机反馈 2026-10-14）：gpt-6-sol/gpt-6.1-sol/gpt-6-luna 过去无规则，
  // 落到 ".*" 兜底只剩 ["disabled","enabled"]（UI 只有关闭/开启）。
  // 适配口径与同代的 gpt-6-astra 一致：low/medium/high/xhigh/max。
  const rules = builtinModelRules();
  const resolve = (modelId: string) =>
    rules.resolve({
      providerId: "cliproxy-codex",
      templateId: "cliproxy-codex",
      modelId,
      apiType: "openai-responses",
      baseUrl: "http://127.0.0.1:8317/v1",
    });
  const expected = ["low", "medium", "high", "xhigh", "max"];
  for (const modelId of ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna"]) {
    const values = resolve(modelId).optionSpecs?.reasoningLevel?.values;
    assert.deepEqual(values, expected, `${modelId} 思考档位`);
  }
  // 同代专属规则（gpt-6-astra）不受通配插入影响。
  assert.deepEqual(resolve("gpt-6-astra").optionSpecs?.reasoningLevel?.values, expected);
});
