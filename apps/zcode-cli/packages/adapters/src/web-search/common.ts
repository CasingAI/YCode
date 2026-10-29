// 独立搜索 API 执行层（docs/specs/web-search-provider-capability.md）。
// 每个供应商一个适配器：把统一的 WebSearchInput 映射到该供应商的端点，
// 并把响应归一化为 WebSearchOutput 的 results/sources 形状。

import type { ActiveWebSearchProvider, WebSearchInput, WebSearchOutput } from "@zcode/contracts";
import { WebSearchResultItemSchema, WebSearchSourceSchema } from "@zcode/contracts";

export const WEB_SEARCH_TIMEOUT_MS = 60_000;
const MAX_RESULTS = 20;

export type WebSearchFetch = typeof globalThis.fetch;

export class WebSearchProviderError extends Error {
  readonly providerId: string;
  readonly status?: number;

  constructor(params: { providerId: string; message: string; status?: number }) {
    super(params.message);
    this.name = "WebSearchProviderError";
    this.providerId = params.providerId;
    this.status = params.status;
  }
}

/** 归一化前的中间结果行：各适配器先映射字段，再走统一的域名过滤与去重。 */
export interface RawSearchResult {
  title?: string;
  url: string;
  pageAge?: string;
  snippet?: string;
}

export function combineAbortSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}

export async function fetchJson(params: {
  url: string;
  body: unknown;
  apiKey: string;
  providerId: string;
  fetchImpl: WebSearchFetch;
  signal: AbortSignal;
}): Promise<unknown> {
  let response: Response;
  try {
    response = await params.fetchImpl(params.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params.body),
      signal: params.signal,
    });
  } catch (error) {
    if (params.signal.aborted) throw error;
    throw new WebSearchProviderError({
      providerId: params.providerId,
      message: `搜索请求失败：${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (!response.ok) {
    throw new WebSearchProviderError({
      providerId: params.providerId,
      status: response.status,
      message: `搜索请求失败（HTTP ${response.status}）`,
    });
  }
  try {
    return await response.json();
  } catch {
    throw new WebSearchProviderError({
      providerId: params.providerId,
      status: response.status,
      message: "搜索响应不是合法 JSON",
    });
  }
}

/** 统一出口：域名过滤（allowed/blocked）、去重、截断并映射为 contracts 形状。 */
export function finalizeSearchOutput(params: {
  input: WebSearchInput;
  provider: ActiveWebSearchProvider;
  rawResults: readonly RawSearchResult[];
  startedAt: number;
  summary?: string;
}): WebSearchOutput {
  const allowed = normalizeDomains(params.input.allowed_domains);
  const blocked = normalizeDomains(params.input.blocked_domains);
  // 去重键用小写 url：供应商可能返回仅大小写不同的同一条结果。
  const seen = new Set<string>();
  const results = [];
  for (const raw of params.rawResults) {
    if (results.length >= MAX_RESULTS) break;
    const host = extractHost(raw.url);
    if (!host || seen.has(raw.url.toLowerCase())) continue;
    if (allowed && !allowed.some((domain) => hostMatchesDomain(host, domain))) continue;
    if (blocked && blocked.some((domain) => hostMatchesDomain(host, domain))) continue;
    seen.add(raw.url.toLowerCase());
    const parsed = WebSearchResultItemSchema.safeParse({
      ...(raw.title === undefined ? {} : { title: raw.title }),
      url: raw.url,
      ...(raw.pageAge === undefined ? {} : { pageAge: raw.pageAge }),
      ...(raw.snippet === undefined ? {} : { snippet: raw.snippet }),
    });
    if (parsed.success) results.push(parsed.data);
  }
  const sources = results
    .map((result) =>
      WebSearchSourceSchema.safeParse({
        ...(result.title === undefined ? {} : { title: result.title }),
        url: result.url,
      }),
    )
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
  return {
    query: params.input.query,
    results,
    sources,
    ...(params.summary === undefined ? {} : { summary: params.summary }),
    durationMs: Date.now() - params.startedAt,
  };
}

function normalizeDomains(domains: readonly string[] | undefined): string[] | undefined {
  const normalized = (domains ?? [])
    .map((domain) => domain.trim().toLowerCase().replace(/^\.+/, ""))
    .filter((domain) => domain.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function extractHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
