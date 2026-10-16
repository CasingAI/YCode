import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntryInfo, SessionStorePort } from "@zcode/contracts";
import { SESSION_ENTRY_CACHE_AFFINITY } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { resolveRuntimeCacheAffinity } from "../src/runtime/helpers/cache-affinity.js";

function cacheAffinityEntry(data: unknown): SessionEntryInfo {
  const timestamp = Date.now();
  return {
    id: "sess-1:cache-affinity",
    sessionID: "sess-1",
    type: SESSION_ENTRY_CACHE_AFFINITY,
    time: { created: timestamp, updated: timestamp },
    data,
  };
}

function runtimeWithStore(
  sessionEntries: SessionStorePort["sessionEntries"],
): AgentRuntimeInternal {
  return {
    sessionId: "sess-1",
    sessionStore: { sessionEntries } as unknown as SessionStorePort,
  } as AgentRuntimeInternal;
}

test("冷恢复从当前会话 entry 解析并缓存 cache affinity", async () => {
  let reads = 0;
  const runtime = runtimeWithStore(async ({ sessionID, type }) => {
    reads += 1;
    assert.equal(sessionID, "sess-1");
    assert.equal(type, SESSION_ENTRY_CACHE_AFFINITY);
    return [cacheAffinityEntry({ cacheAffinityKey: "fork-lineage-key" })];
  });

  assert.equal(await resolveRuntimeCacheAffinity(runtime), "fork-lineage-key");
  assert.equal(await resolveRuntimeCacheAffinity(runtime), "fork-lineage-key");
  assert.equal(reads, 1);
});

test("entry 缺失时回退当前 session ID，读取失败不缓存并允许重试", async () => {
  const missing = runtimeWithStore(async () => []);
  assert.equal(await resolveRuntimeCacheAffinity(missing), "sess-1");

  let reads = 0;
  const unavailable = runtimeWithStore(async () => {
    reads += 1;
    if (reads === 1) throw new Error("store unavailable");
    return [cacheAffinityEntry({ cacheAffinityKey: "recovered-lineage-key" })];
  });
  await assert.rejects(resolveRuntimeCacheAffinity(unavailable), /store unavailable/);
  assert.equal(await resolveRuntimeCacheAffinity(unavailable), "recovered-lineage-key");
  assert.equal(reads, 2);
});

test("已有 session ID fallback 不掩盖 entry 读取错误", async () => {
  let reads = 0;
  const runtime = runtimeWithStore(async () => {
    reads += 1;
    throw new Error("store unavailable");
  });
  runtime.cacheAffinityKey = "sess-1";
  await assert.rejects(resolveRuntimeCacheAffinity(runtime), /store unavailable/);
  assert.equal(reads, 1);
});
