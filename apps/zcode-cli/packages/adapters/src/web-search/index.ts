// 独立搜索 API 执行层（docs/specs/web-search-provider-capability.md）。
export {
  combineAbortSignals,
  fetchJson,
  finalizeSearchOutput,
  optionalString,
  WebSearchProviderError,
  WEB_SEARCH_TIMEOUT_MS,
  type RawSearchResult,
  type WebSearchFetch,
} from "./common.js";
export { searchWithDeepSeek } from "./deepseek-rest.js";
export { searchWithMiniMax } from "./minimax-rest.js";
export { createZhipuMcpSearchClient, type ZhipuMcpSearchClient } from "./zhipu-mcp-search.js";
export {
  createRegistryWebSearchExecutor,
  type WebSearchExecutor,
  type WebSearchPolicy,
  type WebSearchProviderRegistrySource,
} from "./executor.js";
