// 网络搜索执行器：把「策略解析 + Registry 事实 + 供应商适配器」收敛为一个入口。
// 策略（开关+排序）的持有者是 Host 同步的 appRuntimePreferences，执行器只接收读取函数；
// Registry 是 provider 实例与 API Key 的事实源。core 的 WebSearchPort 在会话装配时
// 用本执行器 + context 偏好快照组合而成（docs/specs/web-search-provider-capability.md）。

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
import type { Provider, ProviderRegistryView } from "@zcode/provider";
import { resolveMcpNetwork, type NetworkEgressEnvPolicy } from "../mcp/network.js";
import { createNetworkProxyFetch } from "../network/proxy-fetch.js";
import { searchWithDeepSeek } from "./deepseek-rest.js";
import { searchWithJina } from "./jina-rest.js";
import { searchWithMiniMax } from "./minimax-rest.js";
import { createZhipuMcpSearchClient, type ZhipuMcpSearchClient } from "./zhipu-mcp-search.js";
import { WebSearchProviderError, type WebSearchFetch } from "./common.js";

/** 执行器需要的最小 Registry 面；bootstrap 传入进程级 Provider Registry Service。 */
export interface WebSearchProviderRegistrySource {
  getView(): ProviderRegistryView;
  getProvider(providerId: string): Provider | undefined;
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
  }[] {
    const candidates: {
      providerId: string;
      templateId: WebSearchCapableProviderTemplateId;
    }[] = [];
    for (const provider of options.registry.getView().providers) {
      const templateId = resolveWebSearchTemplateId({
        templateId: provider.templateId,
        apiBaseUrl: provider.config.api?.baseUrl,
      });
      if (templateId === undefined) continue;
      candidates.push({ providerId: provider.providerId, templateId });
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
        const provider = options.registry.getProvider(providerId);
        const templateId = candidates.find((c) => c.providerId === providerId)?.templateId;
        const apiKey = provider?.config.access?.apiKey;
        if (!provider || templateId === undefined || !apiKey) continue;
        return {
          providerId,
          templateId,
          endpoint: endpointFor(templateId),
          apiKey,
          proxyMode: provider.proxyMode,
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
