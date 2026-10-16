import type { ModelStatusContext } from "./runner-status.js";
import { normalizeModelSessionIdForAttribution } from "./runner-status.js";

// OpenAI 前缀缓存按服务端实例存放，同前缀请求不保证路由到同一实例；
// prompt_cache_key 是官方的缓存路由亲和键（spec: docs/specs/openai-prompt-cache-key.md）。
export function resolveOpenAiPromptCacheKey(input: {
  providerKind: string | undefined;
  sessionId?: ModelStatusContext["sessionId"];
  cacheAffinityKey?: string;
}): string | undefined {
  if (input.providerKind !== "openai") {
    return undefined;
  }
  return (
    normalizeModelSessionIdForAttribution(
      (input.cacheAffinityKey as ModelStatusContext["sessionId"]) ?? input.sessionId,
    ) ?? undefined
  );
}
