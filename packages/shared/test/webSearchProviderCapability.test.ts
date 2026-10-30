import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveDefaultWebSearchProviderOrder,
  isIndependentWebSearchTemplateId,
  isWebSearchCapableTemplateId,
  resolveWebSearchProviderOrder,
  resolveWebSearchTemplateId,
  WEB_SEARCH_CAPABLE_PROVIDER_TEMPLATE_IDS,
  WEB_SEARCH_PROVIDER_ENDPOINTS,
} from "../src/provider-search-capability.js";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

// spec: docs/specs/web-search-provider-capability.md
// 识别、默认序与用户序解析是 UI 与 CLI 共用的唯一事实，漂移会让两侧激活项不一致。

test("内置搜索源模板名单与端点表一一对应", () => {
  for (const templateId of WEB_SEARCH_CAPABLE_PROVIDER_TEMPLATE_IDS) {
    const endpoint = WEB_SEARCH_PROVIDER_ENDPOINTS[templateId];
    assert.equal(endpoint.endpoint.startsWith("https://"), true, templateId);
    assert.match(endpoint.endpoint, /^https:\/\//u);
  }
  // 套餐内搜索源优先于按量计费的 DeepSeek / Jina。
  assert.equal(WEB_SEARCH_PROVIDER_ENDPOINTS["zai-api"].defaultPriority, 0);
  assert.equal(WEB_SEARCH_PROVIDER_ENDPOINTS["bigmodel-api"].defaultPriority, 1);
  assert.equal(WEB_SEARCH_PROVIDER_ENDPOINTS["minimax-token-plan"].defaultPriority, 2);
  assert.equal(WEB_SEARCH_PROVIDER_ENDPOINTS.deepseek.defaultPriority, 3);
  assert.equal(WEB_SEARCH_PROVIDER_ENDPOINTS.deepseek.billing, "per-call");
  // jina：独立搜索源模板，query 在路径上，按量计费排最后。
  assert.equal(WEB_SEARCH_PROVIDER_ENDPOINTS.jina.defaultPriority, 4);
  assert.equal(WEB_SEARCH_PROVIDER_ENDPOINTS.jina.billing, "per-call");
  assert.equal(WEB_SEARCH_PROVIDER_ENDPOINTS.jina.kind, "rest");
  assert.equal(WEB_SEARCH_PROVIDER_ENDPOINTS.jina.endpoint, "https://s.jina.ai/");
});

test("搜索源元数据区分来源类型，当前仅 jina 为独立（可手动添加）模板", () => {
  for (const templateId of ["zai-api", "bigmodel-api", "minimax-token-plan", "deepseek"] as const) {
    assert.equal(WEB_SEARCH_PROVIDER_ENDPOINTS[templateId].source, "chat-provider", templateId);
    assert.equal(isIndependentWebSearchTemplateId(templateId), false, templateId);
  }
  assert.equal(WEB_SEARCH_PROVIDER_ENDPOINTS.jina.source, "independent");
  assert.equal(isIndependentWebSearchTemplateId("jina"), true);
  // 非搜索模板不会被误判为独立搜索源。
  assert.equal(isIndependentWebSearchTemplateId("openai" as unknown as string), false);
  // 「添加搜索源」目录只取 independent；当前只有 jina。
  assert.deepEqual(
    WEB_SEARCH_CAPABLE_PROVIDER_TEMPLATE_IDS.filter(isIndependentWebSearchTemplateId),
    ["jina"],
  );
});

test("resolveWebSearchTemplateId 先认 templateId，再做 baseUrl 签名回退", () => {
  assert.equal(resolveWebSearchTemplateId({ templateId: "zai-api" }), "zai-api");
  assert.equal(resolveWebSearchTemplateId({ templateId: "deepseek" }), "deepseek");
  assert.equal(resolveWebSearchTemplateId({ templateId: "jina" }), "jina");
  // jina 只认 templateId：Reader Search 域名没有聊天模板与它共用，不设 baseUrl 签名。
  assert.equal(resolveWebSearchTemplateId({ apiBaseUrl: "https://s.jina.ai" }), undefined);
  // 非 strict 之外的同名 templateId 不该命中（类型层面已约束，运行时防御）。
  assert.equal(isWebSearchCapableTemplateId("openai" as unknown as string), false);
  // baseUrl 回退：Anthropic 兼容网关签名。
  assert.equal(
    resolveWebSearchTemplateId({ apiBaseUrl: "https://api.z.ai/api/anthropic" }),
    "zai-api",
  );
  assert.equal(
    resolveWebSearchTemplateId({ apiBaseUrl: "https://open.bigmodel.cn/api/anthropic/" }),
    "bigmodel-api",
  );
  assert.equal(
    resolveWebSearchTemplateId({ apiBaseUrl: "https://api.deepseek.com/anthropic" }),
    "deepseek",
  );
  // MiniMax 标准模板与 Token Plan 模板共用 baseUrl，签名无法区分，必须靠 templateId。
  assert.equal(
    resolveWebSearchTemplateId({ apiBaseUrl: "https://api.minimaxi.com/v1" }),
    undefined,
  );
  // 标准网关签名不命中。
  assert.equal(
    resolveWebSearchTemplateId({ apiBaseUrl: "https://open.bigmodel.cn/api/paas/v4" }),
    undefined,
  );
  // templateId 与 baseUrl 同时给出时 templateId 优先。
  assert.equal(
    resolveWebSearchTemplateId({
      templateId: "deepseek",
      apiBaseUrl: "https://api.z.ai/api/anthropic",
    }),
    "deepseek",
  );
});

test("deriveDefaultWebSearchProviderOrder 按固定优先级派生，同优先级内稳定排序", () => {
  const derived = deriveDefaultWebSearchProviderOrder([
    { providerId: "ds", templateId: "deepseek" },
    { providerId: "jina-2", templateId: "jina" },
    { providerId: "jina-1", templateId: "jina" },
    { providerId: "zai-b", templateId: "zai-api" },
    { providerId: "zai-a", templateId: "zai-api" },
    { providerId: "mm", templateId: "minimax-token-plan" },
  ]);
  assert.deepEqual(derived, ["zai-a", "zai-b", "mm", "ds", "jina-1", "jina-2"]);
});

test("resolveWebSearchProviderOrder：未初始化走派生，已初始化过滤缺失并追加新候选", () => {
  const candidates = [
    { providerId: "ds", templateId: "deepseek" as const },
    { providerId: "zai", templateId: "zai-api" as const },
  ];
  assert.deepEqual(resolveWebSearchProviderOrder({ order: undefined, candidates }), ["zai", "ds"]);
  // 保存过但候选已删除：剔除；新添加的候选追加尾部。
  assert.deepEqual(
    resolveWebSearchProviderOrder({
      order: ["gone", "ds", "zai"],
      candidates,
    }),
    ["ds", "zai"],
  );
});

test("AppSettings 增加网络搜索字段：总开关缺省开启，排序缺省未初始化", () => {
  const settings = appSettingsSchema.parse({});
  assert.equal(settings.webSearchEnabled, true);
  assert.equal(settings.webSearchProviderOrder, undefined);
  assert.equal(appSettingsSchema.parse({ webSearchEnabled: false }).webSearchEnabled, false);

  const patch = appSettingsPatchSchema.parse({ webSearchProviderOrder: ["a", "b"] });
  assert.deepEqual(patch.webSearchProviderOrder, ["a", "b"]);
  assert.equal(appSettingsPatchSchema.safeParse({ webSearchEnabled: "yes" }).success, false);
  assert.equal(appSettingsPatchSchema.safeParse({ webSearchProviderOrder: [1] }).success, false);
});
