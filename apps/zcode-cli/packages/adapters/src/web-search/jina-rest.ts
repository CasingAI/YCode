// Jina Reader Search API（docs/specs/web-search-provider-capability.md）。
// query 走 URL 路径（POST {endpoint}{encodeURIComponent(query)}），选项走 body；
// 固定 respondWith: "no-content" 只取结果摘要，网页正文抓取属于 WebFetch 职责，
// 不在这里重复消耗按量计费的 token。响应 data[] 的 description 作为结果摘要。

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

/** 与内置搜索源一致的单次结果条数上限（Jina 端点校验 0..20）。 */
const JINA_RESULT_COUNT = 10;

export async function searchWithJina(params: {
  input: WebSearchInput;
  provider: ActiveWebSearchProvider;
  fetchImpl: WebSearchFetch;
  abortSignal?: AbortSignal;
}): Promise<WebSearchOutput> {
  const startedAt = Date.now();
  const payload = await fetchJson({
    url: `${params.provider.endpoint.endpoint}${encodeURIComponent(params.input.query)}`,
    body: {
      count: JINA_RESULT_COUNT,
      respondWith: "no-content",
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
  const data =
    typeof payload === "object" && payload !== null && Array.isArray((payload as Record<string, unknown>).data)
      ? ((payload as Record<string, unknown>).data as readonly unknown[])
      : [];
  const mapped: RawSearchResult[] = [];
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const url = optionalString(record.url);
    if (!url) continue;
    mapped.push({
      url,
      title: optionalString(record.title),
      snippet: optionalString(record.description),
    });
  }
  return mapped;
}
