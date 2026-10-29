import assert from "node:assert/strict";
import test from "node:test";
import type { Provider, ProviderRegistryView } from "@zcode/provider";
import type { WebSearchInput } from "@zcode/contracts";
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
  endpoint: {
    kind: "rest" as const,
    endpoint: "https://api.deepseek.com/v1/tools/search",
    defaultPriority: 3,
    billing: "per-call" as const,
  },
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
  const fetchImpl = (async () => new Response("<html>boom</html>", { status: 200 })) as unknown as WebSearchFetch;
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
      endpoint: {
        kind: "rest" as const,
        endpoint: "https://api.minimaxi.com/v1/coding_plan/search",
        defaultPriority: 2,
        billing: "plan" as const,
      },
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
      endpoint: {
        kind: "rest" as const,
        endpoint: "https://s.jina.ai/",
        defaultPriority: 4,
        billing: "per-call" as const,
      },
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
        endpoint: {
          kind: "rest" as const,
          endpoint: "https://s.jina.ai/",
          defaultPriority: 4,
          billing: "per-call" as const,
        },
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

function fakeProvider(overrides: {
  providerId: string;
  templateId?: string | null;
  baseUrl?: string;
  apiKey?: string;
  proxyMode?: Provider["proxyMode"];
}): Provider {
  return {
    providerId: overrides.providerId,
    ...(overrides.templateId === undefined ? {} : { templateId: overrides.templateId }),
    ...(overrides.proxyMode === undefined ? {} : { proxyMode: overrides.proxyMode }),
    config: {
      ...(overrides.apiKey === undefined ? {} : { access: { type: "api-key", apiKey: overrides.apiKey } }),
      ...(overrides.baseUrl === undefined ? {} : { api: { type: "anthropic", baseUrl: overrides.baseUrl } }),
    },
    models: [],
  } as unknown as Provider;
}

function fakeRegistry(providers: readonly Provider[]) {
  const byId = new Map(providers.map((provider) => [provider.providerId, provider]));
  return {
    getView(): ProviderRegistryView {
      return { revision: 1, providers };
    },
    getProvider(providerId: string): Provider | undefined {
      return byId.get(providerId);
    },
  };
}

test("执行器解析：开关关闭或无候选时不产出激活搜索源", () => {
  const registry = fakeRegistry([fakeProvider({ providerId: "ds", templateId: "deepseek", apiKey: "k" })]);
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
    fakeProvider({ providerId: "zai", templateId: "zai-api", apiKey: "k" }),
    fakeProvider({ providerId: "ds", templateId: "deepseek", apiKey: "k" }),
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
    fakeProvider({ providerId: "ds", templateId: "deepseek" }),
    fakeProvider({ providerId: "zai", templateId: "zai-api", apiKey: "k" }),
  ]);
  const fallback = createRegistryWebSearchExecutor({ registry: missingKey });
  assert.equal(
    fallback.resolveActiveProvider({ enabled: true, order: ["ds", "zai"] })?.providerId,
    "zai",
  );

  // 用户从未整理过排序：按模板固定优先级派生（套餐内优先）。
  const derived = createRegistryWebSearchExecutor({ registry });
  assert.equal(derived.resolveActiveProvider({ enabled: true, order: undefined })?.providerId, "zai");
});

test("执行器解析：templateId 缺失时按 baseUrl 签名识别", () => {
  const registry = fakeRegistry([
    fakeProvider({
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
    fakeProvider({ providerId: "ds", templateId: "deepseek", apiKey: "k" }),
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
    fakeProvider({ providerId: "j1", templateId: "jina", apiKey: "k" }),
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
