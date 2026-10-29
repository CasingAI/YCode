// MiniMax Token Plan 搜索 API：POST /v1/coding_plan/search（docs/specs/web-search-provider-capability.md）。
// 仅接受 Token Plan / Coding Plan 的 sk-cp- Key（套餐内额度）；单次最多 10 条、无分页。

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

export async function searchWithMiniMax(params: {
  input: WebSearchInput;
  provider: ActiveWebSearchProvider;
  fetchImpl: WebSearchFetch;
  abortSignal?: AbortSignal;
}): Promise<WebSearchOutput> {
  const startedAt = Date.now();
  const payload = await fetchJson({
    url: params.provider.endpoint.endpoint,
    body: { q: params.input.query },
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
  const organic =
    typeof payload === "object" && payload !== null && Array.isArray((payload as Record<string, unknown>).organic)
      ? ((payload as Record<string, unknown>).organic as readonly unknown[])
      : [];
  const mapped: RawSearchResult[] = [];
  for (const raw of organic) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const url = optionalString(record.link) ?? optionalString(record.url);
    if (!url) continue;
    mapped.push({
      url,
      title: optionalString(record.title),
      pageAge: optionalString(record.date),
      snippet: optionalString(record.snippet),
    });
  }
  return mapped;
}
