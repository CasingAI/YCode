import {
  parseSessionCacheAffinity,
  SESSION_ENTRY_CACHE_AFFINITY,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";

export function resolveRuntimeCacheAffinity(runtime: AgentRuntimeInternal): Promise<string> {
  if (runtime.cacheAffinityPromise) return runtime.cacheAffinityPromise;
  if (!runtime.sessionStore?.sessionEntries) {
    return Promise.resolve(runtime.cacheAffinityKey ?? String(runtime.sessionId));
  }

  const promise = runtime.sessionStore
    .sessionEntries({
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_CACHE_AFFINITY,
    })
    .then((entries) => {
      const affinity = entries
        .map((entry) => parseSessionCacheAffinity(entry.data))
        .find(Boolean);
      runtime.cacheAffinityKey = affinity?.cacheAffinityKey ?? String(runtime.sessionId);
      return runtime.cacheAffinityKey;
    })
    .catch((error: unknown) => {
      runtime.cacheAffinityPromise = undefined;
      throw error;
    });
  runtime.cacheAffinityPromise = promise;
  return promise;
}
