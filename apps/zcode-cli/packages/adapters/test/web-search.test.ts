import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderRegistryService,
  ProviderTemplate,
  ProviderTemplateMap,
  createAccountProviderConfigSnapshot,
  type ProviderConfigSnapshot,
  type ProviderSource,
  type ResolvedProvider,
} from "@zcode/provider";
import type { WebSearchInput } from "@zcode/contracts";
import { WEB_SEARCH_PROVIDER_ENDPOINTS } from "@zcode/shared";
import {
  combineAbortSignals,
  finalizeSearchOutput,
  WEB_SEARCH_TIMEOUT_MS,
  WebSearchProviderError,
  type RawSearchResult,
  type WebSearchFetch,
} from "../src/web-search/common.js";
import { searchWithDeepSeek } from "../src/web-search/deepseek-rest.js";
import { searchWithJina } from "../src/web-search/jina-rest.js";
import { searchWithMiniMax } from "../src/web-search/minimax-rest.js";
import { createRegistryWebSearchExecutor } from "../src/web-search/executor.js";

// spec: docs/specs/web-search-provider-capability.md
// 供应商适配与执行器解析都打桩网络层，验证请求形状、错误分类与激活序解析。

const BASE_INPUT: WebSearchInput = { query: "zcode web search" };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchResponding(responder: (url: string, body: unknown) => Response): {
  fetchImpl: WebSearchFetch;
  calls: { url: string; body: unknown; headers: Headers }[];
} {
  const calls: { url: string; body: unknown; headers: Headers }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof URL ? input : input);
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ url, body, headers: new Headers(init?.headers) });
    return responder(url, body);
  }) as unknown as WebSearchFetch;
  return { fetchImpl, calls };
}

const PROVIDER = {
  providerId: "personal:deepseek-main",
  templateId: "deepseek",
  endpoint: WEB_SEARCH_PROVIDER_ENDPOINTS.deepseek,
  apiKey: "sk-test",
};

test("DeepSeek 适配器：POST 固定 body，归一化 results 行", async () => {
  const { fetchImpl, calls } = fetchResponding(() =>
    jsonResponse({
      results: [
        { title: "ZCode", url: "https://zcode.example/a", date: "2026-10-01", snippet: "first" },
        { url: "https://zcode.example/b", summary: "second" },
        { title: "no url" },
      ],
    }),
  );
  const output = await searchWithDeepSeek({
    input: BASE_INPUT,
    provider: PROVIDER,
    fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.deepseek.com/v1/tools/search");
  assert.deepEqual(calls[0]!.body, { query: "zcode web search", count: 10, need_content: false });
  assert.equal(calls[0]!.headers.get("authorization"), "Bearer sk-test");
  assert.equal(output.query, BASE_INPUT.query);
  assert.deepEqual(
    output.results.map((result) => result.url),
    ["https://zcode.example/a", "https://zcode.example/b"],
  );
  assert.equal(output.results[0]!.title, "ZCode");
  assert.equal(output.results[0]!.pageAge, "2026-10-01");
  assert.equal(output.results[1]!.snippet, "second");
  assert.equal(output.sources.length, 2);
});

test("DeepSeek 适配器：HTTP 401/402/429 归一为带状态码的可恢复失败", async () => {
  for (const status of [401, 402, 429]) {
    const { fetchImpl } = fetchResponding(() => jsonResponse({ error: "no" }, status));
    await assert.rejects(
      searchWithDeepSeek({ input: BASE_INPUT, provider: PROVIDER, fetchImpl }),
      (error: unknown) => {
        assert.ok(error instanceof WebSearchProviderError);
        assert.equal(error.providerId, PROVIDER.providerId);
        assert.equal(error.status, status);
        return true;
      },
    );
  }
});

test("DeepSeek 适配器：非 JSON 响应报供应商错误而非抛解析异常", async () => {
  const fetchImpl = (async () =>
    new Response("<html>boom</html>", { status: 200 })) as unknown as WebSearchFetch;
  await assert.rejects(
    searchWithDeepSeek({ input: BASE_INPUT, provider: PROVIDER, fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof WebSearchProviderError);
      assert.match(error.message, /JSON/u);
      return true;
    },
  );
});

test("MiniMax 适配器：POST {q}，organic 行映射 url/title/pageAge/snippet", async () => {
  const { fetchImpl, calls } = fetchResponding(() =>
    jsonResponse({
      organic: [
        { title: "MiniMax", link: "https://minimax.example/a", date: "2026-09-30", snippet: "s1" },
        { url: "https://minimax.example/b" },
      ],
    }),
  );
  const output = await searchWithMiniMax({
    input: BASE_INPUT,
    provider: {
      ...PROVIDER,
      providerId: "personal:mm",
      templateId: "minimax-token-plan",
      // MiniMax 走自己的 Token Plan 端点，不能沿用 PROVIDER 里 deepseek 的端点。
      endpoint: WEB_SEARCH_PROVIDER_ENDPOINTS["minimax-token-plan"],
    },
    fetchImpl,
  });
  assert.equal(calls[0]!.url, "https://api.minimaxi.com/v1/coding_plan/search");
  assert.deepEqual(calls[0]!.body, { q: "zcode web search" });
  assert.deepEqual(
    output.results.map((result) => result.url),
    ["https://minimax.example/a", "https://minimax.example/b"],
  );
  assert.equal(output.results[0]!.pageAge, "2026-09-30");
});

test("Jina 适配器：query 走路径、no-content body，data 行映射 title/description", async () => {
  const { fetchImpl, calls } = fetchResponding(() =>
    jsonResponse({
      code: 200,
      status: 20000,
      data: [
        { title: "Jina", url: "https://docs.jina.example/a", description: "first doc" },
        { url: "https://docs.jina.example/b" },
        { title: "no url", description: "skipped" },
      ],
    }),
  );
  const output = await searchWithJina({
    input: { query: "jina search api 中文 example" },
    provider: {
      ...PROVIDER,
      providerId: "personal:jina-1",
      templateId: "jina",
      // Jina 走 Reader Search 端点，query 在路径上；不能沿用 PROVIDER 里 deepseek 的端点。
      endpoint: WEB_SEARCH_PROVIDER_ENDPOINTS.jina,
      apiKey: "jina-key",
    },
    fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    "https://s.jina.ai/jina%20search%20api%20%E4%B8%AD%E6%96%87%20example",
  );
  assert.deepEqual(calls[0]!.body, { count: 10, respondWith: "no-content" });
  assert.equal(calls[0]!.headers.get("authorization"), "Bearer jina-key");
  assert.deepEqual(
    output.results.map((result) => result.url),
    ["https://docs.jina.example/a", "https://docs.jina.example/b"],
  );
  assert.equal(output.results[0]!.title, "Jina");
  assert.equal(output.results[0]!.snippet, "first doc");
  assert.equal(output.results[1]!.snippet, undefined);
  assert.equal(output.sources.length, 2);
});

test("Jina 适配器：非 JSON 响应报供应商错误而非抛解析异常", async () => {
  const fetchImpl = (async () =>
    new Response("<html>boom</html>", { status: 200 })) as unknown as WebSearchFetch;
  await assert.rejects(
    searchWithJina({
      input: BASE_INPUT,
      provider: {
        ...PROVIDER,
        providerId: "personal:jina-1",
        templateId: "jina",
        endpoint: WEB_SEARCH_PROVIDER_ENDPOINTS.jina,
      },
      fetchImpl,
    }),
    (error: unknown) => {
      assert.ok(error instanceof WebSearchProviderError);
      assert.match(error.message, /JSON/u);
      return true;
    },
  );
});

test("finalizeSearchOutput：域名过滤、按 url 去重并截断", () => {
  const raw: RawSearchResult[] = [
    { url: "https://a.example/1" },
    { url: "https://A.example/1" },
    { url: "https://b.example/2" },
    { url: "https://c.example/3" },
  ];
  const output = finalizeSearchOutput({
    input: { query: "q", allowed_domains: ["a.example"] },
    provider: PROVIDER,
    rawResults: raw,
    startedAt: Date.now(),
  });
  assert.deepEqual(
    output.results.map((result) => result.url),
    ["https://a.example/1"],
  );
  const deduped = finalizeSearchOutput({
    input: { query: "q", blocked_domains: [".c.example"] },
    provider: PROVIDER,
    rawResults: raw,
    startedAt: Date.now(),
  });
  assert.deepEqual(
    deduped.results.map((result) => result.url),
    ["https://a.example/1", "https://b.example/2"],
  );
});

test("combineAbortSignals 返回携带超时的合成信号", async () => {
  const external = new AbortController();
  const signal = combineAbortSignals(external.signal, 20);
  assert.equal(signal.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(signal.aborted, true, "超时后合成信号应当中止");
  assert.equal(WEB_SEARCH_TIMEOUT_MS, 60_000);
});

function fakeResolvedProvider(overrides: {
  providerId: string;
  templateId?: string | null;
  baseUrl?: string;
  apiKey?: string;
  proxyMode?: ResolvedProvider["proxyMode"];
  enabled?: boolean;
  providerIssues?: ResolvedProvider["providerIssues"];
}): ResolvedProvider {
  return {
    providerId: overrides.providerId,
    providerName: overrides.providerId,
    ...(overrides.templateId === undefined ? {} : { templateId: overrides.templateId }),
    ...(overrides.proxyMode === undefined ? {} : { proxyMode: overrides.proxyMode }),
    enabled: overrides.enabled ?? true,
    config: {
      ...(overrides.apiKey === undefined
        ? {}
        : { access: { type: "api-key", apiKey: overrides.apiKey } }),
      ...(overrides.baseUrl === undefined
        ? {}
        : { api: { type: "anthropic", baseUrl: overrides.baseUrl } }),
    },
    providerIssues: overrides.providerIssues ?? [],
    models: [],
  } as unknown as ResolvedProvider;
}

function fakeRegistry(providers: readonly ResolvedProvider[]) {
  // 执行器只读解析快照；零模型搜索源不会出现在模型 Registry 里。
  return {
    getSnapshot() {
      return { resolution: { resolvedProviders: providers } };
    },
  };
}

test("执行器解析：开关关闭或无候选时不产出激活搜索源", () => {
  const registry = fakeRegistry([
    fakeResolvedProvider({ providerId: "ds", templateId: "deepseek", apiKey: "k" }),
  ]);
  const executor = createRegistryWebSearchExecutor({ registry });
  assert.equal(
    executor.resolveActiveProvider({ enabled: false, order: undefined }),
    undefined,
    "总开关关闭必须 fail-closed",
  );
  const empty = createRegistryWebSearchExecutor({ registry: fakeRegistry([]) });
  assert.equal(empty.resolveActiveProvider({ enabled: true, order: undefined }), undefined);
});

test("执行器解析：按序取第一个 Key 可用项；排序外的候选按默认序兜底", () => {
  const registry = fakeRegistry([
    fakeResolvedProvider({ providerId: "zai", templateId: "zai-api", apiKey: "k" }),
    fakeResolvedProvider({ providerId: "ds", templateId: "deepseek", apiKey: "k" }),
  ]);
  const executor = createRegistryWebSearchExecutor({ registry });
  const active = executor.resolveActiveProvider({
    enabled: true,
    order: ["ds", "zai"],
  });
  assert.equal(active?.providerId, "ds", "用户排序第一的激活");
  assert.equal(active?.templateId, "deepseek");
  assert.equal(active?.proxyMode, undefined);

  // 排第一的没有 Key：跳过它取下一个可解析项，不让非空候选落到无激活项。
  const missingKey = fakeRegistry([
    fakeResolvedProvider({ providerId: "ds", templateId: "deepseek" }),
    fakeResolvedProvider({ providerId: "zai", templateId: "zai-api", apiKey: "k" }),
  ]);
  const fallback = createRegistryWebSearchExecutor({ registry: missingKey });
  assert.equal(
    fallback.resolveActiveProvider({ enabled: true, order: ["ds", "zai"] })?.providerId,
    "zai",
  );

  // 用户从未整理过排序：按模板固定优先级派生（套餐内优先）。
  const derived = createRegistryWebSearchExecutor({ registry });
  assert.equal(
    derived.resolveActiveProvider({ enabled: true, order: undefined })?.providerId,
    "zai",
  );
});

test("执行器解析：templateId 缺失时按 baseUrl 签名识别", () => {
  const registry = fakeRegistry([
    fakeResolvedProvider({
      providerId: "sig",
      baseUrl: "https://api.z.ai/api/anthropic",
      apiKey: "k",
    }),
  ]);
  const executor = createRegistryWebSearchExecutor({ registry });
  const active = executor.resolveActiveProvider({ enabled: true, order: undefined });
  assert.equal(active?.templateId, "zai-api");
  assert.equal(active?.endpoint.kind, "mcp");
});

test("执行器执行：deepseek 走 REST 且透传 abortSignal", async () => {
  const { fetchImpl, calls } = fetchResponding(() => jsonResponse({ results: [] }));
  const registry = fakeRegistry([
    fakeResolvedProvider({ providerId: "ds", templateId: "deepseek", apiKey: "k" }),
  ]);
  const executor = createRegistryWebSearchExecutor({ registry, fetchImpl });
  const provider = executor.resolveActiveProvider({ enabled: true, order: undefined });
  assert.ok(provider);
  const controller = new AbortController();
  const output = await executor.search(BASE_INPUT, provider, {
    abortSignal: controller.signal,
  });
  assert.equal(output.results.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, provider.endpoint.endpoint);
});

test("执行器执行：jina 实例按模板识别并走 REST 路径端点", async () => {
  const { fetchImpl, calls } = fetchResponding(() => jsonResponse({ data: [] }));
  const registry = fakeRegistry([
    fakeResolvedProvider({ providerId: "j1", templateId: "jina", apiKey: "k" }),
  ]);
  const executor = createRegistryWebSearchExecutor({ registry, fetchImpl });
  const provider = executor.resolveActiveProvider({ enabled: true, order: undefined });
  assert.ok(provider);
  assert.equal(provider.templateId, "jina");
  assert.equal(provider.endpoint.endpoint, "https://s.jina.ai/");
  const output = await executor.search(BASE_INPUT, provider, {
    abortSignal: new AbortController().signal,
  });
  assert.equal(output.results.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://s.jina.ai/zcode%20web%20search");
});

// 以下用真实 ProviderConfigResolver + ProviderRegistryService 锁定 spec 验收 9：
// 零模型独立搜索源（Jina）不进聊天模型 Registry，但必须仍能被执行器解析。

class MutableConfigSource implements ProviderSource<ProviderConfigSnapshot> {
  constructor(private snapshot: ProviderConfigSnapshot) {}

  async read(): Promise<ProviderConfigSnapshot> {
    return this.snapshot;
  }

  onDidChange(): () => void {
    return () => {};
  }
}

const JINA_TEMPLATE = new ProviderTemplate({
  templateId: "jina",
  templateNameMap: { "zh-CN": "Jina", "en-US": "Jina" },
  config: new ProviderConfig({
    access: new ApiKeyAccessConfig({ apiKeyManagementUrl: "https://jina.ai/api-keys" }),
    api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl: "https://s.jina.ai" }),
  }),
});

const DEEPSEEK_TEMPLATE = new ProviderTemplate({
  templateId: "deepseek",
  templateNameMap: { "zh-CN": "DeepSeek", "en-US": "DeepSeek" },
  config: new ProviderConfig({
    access: new ApiKeyAccessConfig({
      apiKeyManagementUrl: "https://platform.deepseek.com/api_keys",
    }),
    api: new ProviderApiConfig({
      type: "anthropic-messages",
      baseUrl: "https://api.deepseek.com/anthropic",
    }),
  }),
});

function chatTemplate(
  templateId: "minimax-token-plan" | "zai-api" | "bigmodel-api",
  baseUrl: string,
): ProviderTemplate {
  return new ProviderTemplate({
    templateId,
    templateNameMap: { "zh-CN": templateId, "en-US": templateId },
    config: new ProviderConfig({
      access: new ApiKeyAccessConfig({ apiKeyManagementUrl: "https://example.test/keys" }),
      api: new ProviderApiConfig({ type: "anthropic-messages", baseUrl }),
    }),
  });
}

const MINIMAX_TEMPLATE = chatTemplate("minimax-token-plan", "https://api.minimaxi.com");
const ZAI_TEMPLATE = chatTemplate("zai-api", "https://api.z.ai/api/anthropic");
const BIGMODEL_TEMPLATE = chatTemplate("bigmodel-api", "https://open.bigmodel.cn/api/anthropic");

function keyAccess(
  apiKey: string,
  type: "api-key" | "zhipu-coding-plan-api-key" = "api-key",
): ApiKeyAccessConfig {
  return new ApiKeyAccessConfig({ type, apiKey });
}

function completeModelConfig(): ModelConfig {
  return ModelConfig.fromData({
    enabled: true,
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
      supportsJsonSchemaOutput: false,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: { values: ["disabled", "high"], map: '{"effort": reasoningLevel}' },
      maxOutputTokens: { max: 4096, map: '{"max_tokens": maxOutputTokens}' },
    },
  });
}

function providerConfigSnapshot(input: {
  personal: ProviderConfigMap;
  templates?: ProviderTemplateMap;
  personalModels?: ModelConfigRules;
}): ProviderConfigSnapshot {
  return {
    revision: "config-test",
    zcodeBuiltinRevision: "builtin-test",
    personalRevision: "personal-test",
    zcodeBuiltinProviders: ProviderConfigMap.empty(),
    zcodeBuiltinProviderTemplates: input.templates ?? ProviderTemplateMap.empty(),
    personalProviders: input.personal,
    zcodeBuiltinModelRules: ModelConfigRules.empty(),
    personalModels: input.personalModels ?? ModelConfigRules.empty(),
  };
}

async function startRegistry(config: ProviderConfigSnapshot): Promise<ProviderRegistryService> {
  const service = new ProviderRegistryService({
    configSource: new MutableConfigSource(config),
    accountSource: {
      async read() {
        return createAccountProviderConfigSnapshot(
          config.zcodeBuiltinRevision,
          ProviderConfigMap.empty(),
        );
      },
      onDidChange() {
        return () => {};
      },
    },
  });
  await service.start();
  return service;
}

test("真实 resolver/service：零模型 Jina 不进模型 Registry，但执行器仍可激活并执行", async () => {
  const service = await startRegistry(
    providerConfigSnapshot({
      personal: new ProviderConfigMap([
        {
          providerId: "personal:jina-1",
          templateId: "jina",
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "jina-key" }),
          }),
        },
      ]),
      templates: new ProviderTemplateMap([["jina", JINA_TEMPLATE]]),
    }),
  );
  try {
    const snapshot = service.getSnapshot();
    assert.ok(snapshot);
    assert.equal(
      snapshot.resolution.resolvedProviders.some((item) => item.providerId === "personal:jina-1"),
      true,
      "零模型实例必须保留在解析事实中",
    );
    assert.equal(
      snapshot.resolution.registryProviders.some((item) => item.providerId === "personal:jina-1"),
      false,
      "零模型实例不应进入聊天模型 Registry",
    );

    const { fetchImpl, calls } = fetchResponding(() => jsonResponse({ data: [] }));
    const executor = createRegistryWebSearchExecutor({ registry: service, fetchImpl });
    const active = executor.resolveActiveProvider({ enabled: true, order: undefined });
    assert.equal(active?.providerId, "personal:jina-1");
    assert.equal(active?.templateId, "jina");
    assert.equal(active?.endpoint.endpoint, "https://s.jina.ai/");
    if (!active) return;
    await executor.search(BASE_INPUT, active, {
      abortSignal: new AbortController().signal,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://s.jina.ai/zcode%20web%20search");
  } finally {
    service.dispose();
  }
});

test("真实 resolver/service：可用聊天源仍可解析，并与独立源共用排序", async () => {
  const service = await startRegistry(
    providerConfigSnapshot({
      personal: new ProviderConfigMap([
        {
          providerId: "personal:deepseek-main",
          templateId: "deepseek",
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "ds-key" }),
            personalModelIds: ["deepseek-flash"],
          }),
        },
        {
          providerId: "personal:jina-1",
          templateId: "jina",
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "jina-key" }),
          }),
        },
      ]),
      templates: new ProviderTemplateMap([
        ["deepseek", DEEPSEEK_TEMPLATE],
        ["jina", JINA_TEMPLATE],
      ]),
      personalModels: new ModelConfigRules([
        {
          type: "provider-model",
          providerId: "personal:deepseek-main",
          modelId: "deepseek-flash",
          config: completeModelConfig(),
        },
      ]),
    }),
  );
  try {
    assert.equal(
      service
        .getSnapshot()
        ?.resolution.registryProviders.some((item) => item.providerId === "personal:deepseek-main"),
      true,
      "可用聊天源仍进入模型 Registry",
    );
    const executor = createRegistryWebSearchExecutor({ registry: service });
    const deepseek = executor.resolveActiveProvider({
      enabled: true,
      order: ["personal:deepseek-main", "personal:jina-1"],
    });
    assert.equal(deepseek?.providerId, "personal:deepseek-main");
    assert.equal(deepseek?.templateId, "deepseek");
    const jina = executor.resolveActiveProvider({
      enabled: true,
      order: ["personal:jina-1", "personal:deepseek-main"],
    });
    assert.equal(jina?.providerId, "personal:jina-1");
    // 未初始化排序沿用模板固定优先级：DeepSeek（3）在 Jina（4）前。
    assert.equal(
      executor.resolveActiveProvider({ enabled: true, order: undefined })?.providerId,
      "personal:deepseek-main",
    );
  } finally {
    service.dispose();
  }
});

test("真实 resolver/service：四类聊天源的 Key 型 access 均可激活（含 Z.ai/BigModel legacy）", async () => {
  const cases = [
    {
      name: "deepseek",
      providerId: "personal:ds",
      templateId: "deepseek",
      access: "api-key",
      template: DEEPSEEK_TEMPLATE,
      endpoint: WEB_SEARCH_PROVIDER_ENDPOINTS.deepseek.endpoint,
    },
    {
      name: "minimax-token-plan",
      providerId: "personal:mm",
      templateId: "minimax-token-plan",
      access: "api-key",
      template: MINIMAX_TEMPLATE,
      endpoint: WEB_SEARCH_PROVIDER_ENDPOINTS["minimax-token-plan"].endpoint,
    },
    {
      name: "zai-api legacy",
      providerId: "personal:zai",
      templateId: "zai-api",
      access: "zhipu-coding-plan-api-key",
      template: ZAI_TEMPLATE,
      endpoint: WEB_SEARCH_PROVIDER_ENDPOINTS["zai-api"].endpoint,
    },
    {
      name: "bigmodel-api legacy",
      providerId: "personal:bigmodel",
      templateId: "bigmodel-api",
      access: "zhipu-coding-plan-api-key",
      template: BIGMODEL_TEMPLATE,
      endpoint: WEB_SEARCH_PROVIDER_ENDPOINTS["bigmodel-api"].endpoint,
    },
  ] as const;

  for (const item of cases) {
    const service = await startRegistry(
      providerConfigSnapshot({
        personal: new ProviderConfigMap([
          {
            providerId: item.providerId,
            templateId: item.templateId,
            config: new ProviderConfig({
              group: "standard-personal",
              access: keyAccess("key", item.access),
              personalModelIds: ["test-model"],
            }),
          },
        ]),
        templates: new ProviderTemplateMap([[item.templateId, item.template]]),
        personalModels: new ModelConfigRules([
          {
            type: "provider-model",
            providerId: item.providerId,
            modelId: "test-model",
            config: completeModelConfig(),
          },
        ]),
      }),
    );
    try {
      assert.equal(
        service
          .getSnapshot()
          ?.resolution.registryProviders.some(
            (provider) => provider.providerId === item.providerId,
          ),
        true,
        `${item.name} 仍应进入模型 Registry`,
      );
      const executor = createRegistryWebSearchExecutor({ registry: service });
      const active = executor.resolveActiveProvider({ enabled: true, order: undefined });
      assert.equal(active?.providerId, item.providerId, item.name);
      assert.equal(active?.templateId, item.templateId, item.name);
      assert.equal(active?.apiKey, "key", item.name);
      assert.equal(active?.endpoint.endpoint, item.endpoint, item.name);
    } finally {
      service.dispose();
    }
  }
});

test("真实 resolver/service：disabled、无 Key、配置不完整的搜索源都不激活", async () => {
  const assertInactive = async (config: ProviderConfigSnapshot, label: string) => {
    const service = await startRegistry(config);
    try {
      const executor = createRegistryWebSearchExecutor({ registry: service });
      assert.equal(
        executor.resolveActiveProvider({ enabled: true, order: undefined }),
        undefined,
        label,
      );
    } finally {
      service.dispose();
    }
  };

  await assertInactive(
    providerConfigSnapshot({
      personal: new ProviderConfigMap([
        {
          providerId: "personal:jina-1",
          templateId: "jina",
          enabled: false,
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "jina-key" }),
          }),
        },
      ]),
      templates: new ProviderTemplateMap([["jina", JINA_TEMPLATE]]),
    }),
    "disabled 的搜索源不得激活",
  );
  await assertInactive(
    providerConfigSnapshot({
      personal: new ProviderConfigMap([
        {
          providerId: "personal:jina-1",
          templateId: "jina",
          config: new ProviderConfig({ group: "standard-personal" }),
        },
      ]),
      templates: new ProviderTemplateMap([["jina", JINA_TEMPLATE]]),
    }),
    "无 Key 的搜索源不得激活",
  );
  await assertInactive(
    providerConfigSnapshot({
      personal: new ProviderConfigMap([
        {
          providerId: "personal:jina-1",
          templateId: "jina",
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "jina-key" }),
          }),
        },
      ]),
    }),
    "模板缺失导致配置不完整的搜索源不得激活",
  );
});
