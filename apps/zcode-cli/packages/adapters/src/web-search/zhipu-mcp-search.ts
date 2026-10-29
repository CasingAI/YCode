// 智谱 webSearchPrime Remote MCP 搜索客户端（docs/specs/web-search-provider-capability.md）。
// Z.ai / BigModel 的 Coding Plan 搜索以 streamable-http MCP 形式暴露：
// 同一把套餐 Key（Bearer）直连端点，工具固定为 webSearchPrime。
// 连接按 endpoint+Key 池化复用；失败即逐出，下次调用重建。

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type {
  ActiveWebSearchProvider,
  McpProxyMode,
  WebSearchInput,
  WebSearchOutput,
} from "@zcode/contracts";
import {
  combineAbortSignals,
  finalizeSearchOutput,
  optionalString,
  WebSearchProviderError,
  WEB_SEARCH_TIMEOUT_MS,
  type RawSearchResult,
  type WebSearchFetch,
} from "./common.js";

interface CachedMcpSession {
  client: Client;
  queryField: string;
  toolName: string;
}

export interface ZhipuMcpSearchClient {
  search(params: {
    input: WebSearchInput;
    provider: ActiveWebSearchProvider;
    abortSignal?: AbortSignal;
  }): Promise<WebSearchOutput>;
  dispose(): void;
}

export function createZhipuMcpSearchClient(
  options: { resolveFetch?: (proxyMode: McpProxyMode | undefined) => WebSearchFetch } = {},
): ZhipuMcpSearchClient {
  const sessions = new Map<string, Promise<CachedMcpSession>>();

  // 连接按 endpoint+Key+代理模式 池化：不同 proxyMode 的 provider 走不同出口 fetch。
  function sessionCacheKey(provider: ActiveWebSearchProvider): string {
    return `${provider.endpoint.endpoint}|${provider.apiKey}|${provider.proxyMode ?? "default"}`;
  }

  async function acquireSession(provider: ActiveWebSearchProvider): Promise<CachedMcpSession> {
    const cacheKey = sessionCacheKey(provider);
    const existing = sessions.get(cacheKey);
    if (existing) {
      try {
        return await existing;
      } catch (error) {
        // 缓存的就是一次失败连接：逐出后重建，不把旧错误放大成永久失败。
        sessions.delete(cacheKey);
        throw error;
      }
    }
    const created = connectSession(provider).catch((error) => {
      sessions.delete(cacheKey);
      throw error;
    });
    sessions.set(cacheKey, created);
    return created;
  }

  async function connectSession(provider: ActiveWebSearchProvider): Promise<CachedMcpSession> {
    const client = new Client({
      name: "ycode-web-search",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(new URL(provider.endpoint.endpoint), {
      requestInit: {
        headers: { Authorization: `Bearer ${provider.apiKey}` },
      },
      ...(options.resolveFetch ? { fetch: options.resolveFetch(provider.proxyMode) } : {}),
    });
    await client.connect(transport);
    const toolName = provider.endpoint.toolName ?? "webSearchPrime";
    const queryField = await resolveQueryField(client, toolName);
    return { client, queryField, toolName };
  }

  async function resolveQueryField(client: Client, toolName: string): Promise<string> {
    try {
      const tools = await client.listTools();
      const tool = tools.tools.find((tool) => tool.name === toolName);
      const properties =
        typeof tool?.inputSchema === "object" && tool.inputSchema !== null
          ? ((tool.inputSchema as Record<string, unknown>).properties as
              | Record<string, unknown>
              | undefined)
          : undefined;
      if (properties && typeof properties === "object" && "query" in properties) return "query";
      if (properties) {
        const firstStringProperty = Object.entries(properties).find(
          ([, schema]) =>
            typeof schema === "object" && schema !== null && (schema as Record<string, unknown>).type === "string",
        );
        if (firstStringProperty) return firstStringProperty[0];
      }
    } catch {
      // 自省失败不阻断搜索：按最常见的字段名尝试，服务端会给出明确错误。
    }
    return "query";
  }

  return {
    async search({ input, provider, abortSignal }) {
      const startedAt = Date.now();
      const signal = combineAbortSignals(abortSignal, WEB_SEARCH_TIMEOUT_MS);
      let session: CachedMcpSession;
      try {
        session = await acquireSession(provider);
      } catch (error) {
        throw new WebSearchProviderError({
          providerId: provider.providerId,
          message: `搜索 MCP 连接失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      let result: unknown;
      try {
        // MCP SDK v2 的 callTool 只有 (params, options) 两个形参；signal 走 options。
        result = await session.client.callTool(
          {
            name: session.toolName,
            arguments: { [session.queryField]: input.query },
          },
          { signal },
        );
      } catch (error) {
        // 连接可能已失效（服务端关流、鉴权变化）：逐出缓存，下次调用重建。
        sessions.delete(sessionCacheKey(provider));
        throw new WebSearchProviderError({
          providerId: provider.providerId,
          message: `搜索 MCP 调用失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return finalizeSearchOutput({
        input,
        provider,
        rawResults: parseMcpResults(result),
        startedAt,
      });
    },
    dispose() {
      for (const pending of sessions.values()) {
        void pending
          .then((session) => session.client.close())
          .catch(() => {
            // 关闭失败无需处理：连接随进程退出释放。
          });
      }
      sessions.clear();
    },
  };
}

function parseMcpResults(result: unknown): RawSearchResult[] {
  const texts = collectTextBlocks(result);
  const mapped: RawSearchResult[] = [];
  for (const text of texts) {
    mapped.push(...parseSearchText(text));
  }
  return mapped;
}

function collectTextBlocks(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectTextBlocks(item));
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.content)) return collectTextBlocks(record.content);
  if (typeof record.text === "string") return [record.text];
  return [];
}

function parseSearchText(text: string): RawSearchResult[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const parsed = tryParseJson(trimmed);
  if (parsed !== undefined) {
    const fromJson = parseResultRecords(parsed);
    if (fromJson.length > 0) return fromJson;
  }
  // 非 JSON 文本兜底：抽取正文里的 URL 作为无标题结果，保证模型至少拿到可追溯链接。
  const results: RawSearchResult[] = [];
  const urlPattern = /https?:\/\/[^\s"'<>\\]+/gu;
  for (const match of trimmed.matchAll(urlPattern)) {
    results.push({ url: match[0] });
  }
  return results;
}

function tryParseJson(text: string): unknown {
  if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parseResultRecords(payload: unknown): RawSearchResult[] {
  const array = findResultArray(payload);
  const mapped: RawSearchResult[] = [];
  for (const raw of array) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const url = optionalString(record.url) ?? optionalString(record.link) ?? optionalString(record.href);
    if (!url) continue;
    mapped.push({
      url,
      title: optionalString(record.title),
      pageAge: optionalString(record.date) ?? optionalString(record.publish_time),
      snippet: optionalString(record.snippet) ?? optionalString(record.summary),
    });
  }
  return mapped;
}

function findResultArray(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object" || payload === null) return [];
  for (const key of ["results", "organic", "data", "items", "search_results"]) {
    const value = (payload as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}
