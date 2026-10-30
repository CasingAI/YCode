// 网络搜索执行器：把「策略解析 + 解析快照事实 + 供应商适配器」收敛为一个入口。
// 策略（开关+排序）的持有者是 Host 同步的 appRuntimePreferences，执行器只接收读取函数；
// ProviderRegistryService 的解析快照（resolution.resolvedProviders）是 provider 实例与
// API Key 的事实源。core 的 WebSearchPort 在会话装配时用本执行器 + context 偏好快照
// 组合而成（docs/specs/web-search-provider-capability.md）。

import type {
  ActiveWebSearchProvider,
  McpProxyMode,
  WebSearchInput,
  WebSearchOutput,
} from "@zcode/contracts";
import {
  deriveDefaultWebSearchProviderOrder,
  resolveWebSearchProviderOrder,
  resolveWebSearchTemplateId,
  WEB_SEARCH_PROVIDER_ENDPOINTS,
  type WebSearchCapableProviderTemplateId,
} from "@zcode/shared";
import { isApiKeyAccess, type ResolvedProvider } from "@zcode/provider";
import { resolveMcpNetwork, type NetworkEgressEnvPolicy } from "../mcp/network.js";
import { createNetworkProxyFetch } from "../network/proxy-fetch.js";
import { searchWithDeepSeek } from "./deepseek-rest.js";
import { searchWithJina } from "./jina-rest.js";
import { searchWithMiniMax } from "./minimax-rest.js";
import { createZhipuMcpSearchClient, type ZhipuMcpSearchClient } from "./zhipu-mcp-search.js";
import { WebSearchProviderError, type WebSearchFetch } from "./common.js";

/** 解析快照中执行器需要的最小只读面；bootstrap 传入进程级 Provider Registry Service。 */
export interface WebSearchResolvedProvidersSnapshot {
  readonly resolution: {
    readonly resolvedProviders: readonly ResolvedProvider[];
  };
}

/**
 * 执行器只读解析快照，不读聊天模型 Registry。
 * 零模型搜索源（Jina）不会进入 registryProviders，按模型数量筛源会直接漏掉它；
 * 这里刻意不暴露 getView/getProvider，避免调用方再次退回模型 Registry 语义。
 */
export interface WebSearchProviderRegistrySource {
  getSnapshot(): WebSearchResolvedProvidersSnapshot | null;
}

export interface WebSearchPolicy {
  enabled: boolean;
  /** undefined = 用户从未整理过排序，按模板固定优先级派生默认序。 */
  order?: readonly string[];
}

export interface WebSearchExecutor {
  resolveActiveProvider(policy: WebSearchPolicy): ActiveWebSearchProvider | undefined;
  search(
    input: WebSearchInput,
    provider: ActiveWebSearchProvider,
    options: { abortSignal?: AbortSignal },
  ): Promise<WebSearchOutput>;
  dispose(): void;
}

export function createRegistryWebSearchExecutor(options: {
  registry: WebSearchProviderRegistrySource;
  /** 测试注入；生产按 provider.proxyMode 走 resolveWebSearchFetch。 */
  fetchImpl?: WebSearchFetch;
  env?: NodeJS.ProcessEnv;
  /** 与 MCP 池同源的进程级网络出口材料（docs/specs/network-settings.md）。 */
  network?: NetworkEgressEnvPolicy;
}): WebSearchExecutor {
  const mcpClient: ZhipuMcpSearchClient = createZhipuMcpSearchClient({
    resolveFetch: (proxyMode) => resolveWebSearchFetch(proxyMode),
  });

  const fetchByProxyMode = new Map<string, WebSearchFetch>();

  function resolveWebSearchFetch(proxyMode: McpProxyMode | undefined): WebSearchFetch {
    if (options.fetchImpl) return options.fetchImpl;
    const cacheKey = proxyMode ?? "default";
    const cached = fetchByProxyMode.get(cacheKey);
    if (cached) return cached;
    const resolved = resolveMcpNetwork(proxyMode, options.network);
    const created = createNetworkProxyFetch({
      caCertFile: resolved.caCertFile,
      // direct 模式置空 env，屏蔽 resolveProxyForRequest 的 ZCODE_HTTP_PROXY 候选；
      // 非 direct 仍传真实 env，那条兜底候选是既有行为的一部分。
      env: resolved.ignoreProxyEnv ? {} : (options.env ?? process.env),
      httpProxy: resolved.httpProxy,
      noProxy: resolved.noProxy,
    });
    fetchByProxyMode.set(cacheKey, created);
    return created;
  }

  function detectCandidates(): {
    providerId: string;
    templateId: WebSearchCapableProviderTemplateId;
    provider: ResolvedProvider;
  }[] {
    const snapshot = options.registry.getSnapshot();
    if (!snapshot) return [];
    const candidates: {
      providerId: string;
      templateId: WebSearchCapableProviderTemplateId;
      provider: ResolvedProvider;
    }[] = [];
    for (const provider of snapshot.resolution.resolvedProviders) {
      // 搜索源是配置事实，不是聊天模型事实：Jina 等零模型实例不会进入模型 Registry，
      // 因此只筛「启用 + 配置完整 + 模板命中」，模型数量不参与判定。
      if (!provider.enabled || provider.providerIssues.length > 0) continue;
      const templateId = resolveWebSearchTemplateId({
        templateId: provider.templateId,
        apiBaseUrl: provider.config.api?.baseUrl,
      });
      if (templateId === undefined) continue;
      candidates.push({ providerId: provider.providerId, templateId, provider });
    }
    return candidates;
  }

  return {
    resolveActiveProvider(policy) {
      if (!policy.enabled) return undefined;
      const candidates = detectCandidates();
      if (candidates.length === 0) return undefined;
      const orderedIds = resolveWebSearchProviderOrder({
        order: policy.order,
        candidates,
      });
      // 排序外的兜底：用户从未整理过但 shared 派生与 detection 之间出现漂移时，
      // 仍按派生序保底取第一个可解析项，绝不让非空候选落到“无激活项”。
      const orderedOrDerived =
        orderedIds.length > 0 ? orderedIds : deriveDefaultWebSearchProviderOrder(candidates);
      for (const providerId of orderedOrDerived) {
        const candidate = candidates.find((item) => item.providerId === providerId);
        const apiKey = candidate ? readApiKey(candidate.provider) : undefined;
        if (!candidate || !apiKey) continue;
        return {
          providerId,
          templateId: candidate.templateId,
          endpoint: endpointFor(candidate.templateId),
          apiKey,
          proxyMode: candidate.provider.proxyMode,
        };
      }
      return undefined;
    },

    async search(input, provider, options) {
      switch (provider.templateId) {
        case "deepseek":
          return await searchWithDeepSeek({
            input,
            provider,
            fetchImpl: resolveWebSearchFetch(provider.proxyMode),
            abortSignal: options.abortSignal,
          });
        case "minimax-token-plan":
          return await searchWithMiniMax({
            input,
            provider,
            fetchImpl: resolveWebSearchFetch(provider.proxyMode),
            abortSignal: options.abortSignal,
          });
        case "jina":
          return await searchWithJina({
            input,
            provider,
            fetchImpl: resolveWebSearchFetch(provider.proxyMode),
            abortSignal: options.abortSignal,
          });
        case "zai-api":
        case "bigmodel-api":
          return await mcpClient.search({
            input,
            provider,
            abortSignal: options.abortSignal,
          });
        default: {
          // resolveActiveProvider 只会产出已知模板；这里是穷尽性保护。
          throw new WebSearchProviderError({
            providerId: provider.providerId,
            message: `未支持的搜索源模板：${provider.templateId}`,
          });
        }
      }
    },

    dispose() {
      mcpClient.dispose();
    },
  };
}

function endpointFor(templateId: WebSearchCapableProviderTemplateId) {
  // shared 的端点描述按模板建表（Record 全键覆盖），缺表只可能是未来的代码缺口。
  return WEB_SEARCH_PROVIDER_ENDPOINTS[templateId];
}

function readApiKey(provider: ResolvedProvider): string | undefined {
  const access = provider.config.access;
  // Z.ai / BigModel Coding Plan 使用 zhipu-coding-plan-api-key；判定复用 provider 公开判据。
  return isApiKeyAccess(access) ? (access.apiKey ?? undefined) : undefined;
}
