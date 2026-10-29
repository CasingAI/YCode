// DeepSeek 独立搜索 API：POST /v1/tools/search（docs/specs/web-search-provider-capability.md）。
// 同一把平台 API Key 鉴权；按成功请求计费，因此不并发、单次调用。
// 网页正文抓取属于 WebFetch 职责，这里固定 need_content=false 不重复消耗计费。

import type { ActiveWebSearchProvider, WebSearchInput, WebSearchOutput } from "@zcode/contracts";
import {
  combineAbortSignals,
  fetchJson,
  finalizeSearchOutput,
  optionalString,
  WEB_SEARCH_TIMEOUT_MS,
  type RawSearchResult,
  type WebSearchFetch,
} from "./common.js";

export async function searchWithDeepSeek(params: {
  input: WebSearchInput;
  provider: ActiveWebSearchProvider;
  fetchImpl: WebSearchFetch;
  abortSignal?: AbortSignal;
}): Promise<WebSearchOutput> {
  const startedAt = Date.now();
  const payload = await fetchJson({
    url: params.provider.endpoint.endpoint,
    body: {
      query: params.input.query,
      count: 10,
      need_content: false,
    },
    apiKey: params.provider.apiKey,
    providerId: params.provider.providerId,
    fetchImpl: params.fetchImpl,
    signal: combineAbortSignals(params.abortSignal, WEB_SEARCH_TIMEOUT_MS),
  });
  return finalizeSearchOutput({
    input: params.input,
    provider: params.provider,
    rawResults: parseResults(payload),
    startedAt,
  });
}

function parseResults(payload: unknown): RawSearchResult[] {
  const results =
    typeof payload === "object" && payload !== null && Array.isArray((payload as Record<string, unknown>).results)
      ? ((payload as Record<string, unknown>).results as readonly unknown[])
      : [];
  const mapped: RawSearchResult[] = [];
  for (const raw of results) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const url = optionalString(record.url);
    if (!url) continue;
    mapped.push({
      url,
      title: optionalString(record.title),
      pageAge: optionalString(record.date),
      snippet: optionalString(record.snippet) ?? optionalString(record.summary),
    });
  }
  return mapped;
}
