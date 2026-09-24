import assert from "node:assert/strict";
import test from "node:test";
import type { OpenCodeUsageSnapshot } from "@zcode/shared";
import {
  beginOpenCodeUsageProjectionRequest,
  clearOpenCodeUsageProjection,
  commitOpenCodeUsageProjection,
  invalidateOpenCodeUsageProjection,
  isCurrentOpenCodeUsageProjectionRequest,
  projectOpenCodeUsageResponse,
  readOpenCodeUsageProjection,
} from "@/hooks/openCodeUsageProjectionCache.js";

function createSnapshot(params: {
  providerId: string;
  fetchedAt?: number;
  error?: OpenCodeUsageSnapshot["error"];
  percentage?: number;
  withWindows?: boolean;
}): OpenCodeUsageSnapshot {
  return {
    providerId: params.providerId,
    workspaceId: `wrk_${params.providerId}`,
    fetchedAt: params.fetchedAt ?? 1_000,
    windows:
      params.withWindows === false
        ? []
        : [
            {
              key: "rolling",
              status: "ok",
              usagePercent: params.percentage ?? 10,
              usage: 100,
              limit: 1_000,
              resetInSec: null,
              resetAt: null,
            },
          ],
    error: params.error ?? null,
    errorMessage: null,
  };
}

test("缓存按 Service 实例和 providerId 隔离", () => {
  const serviceA = {};
  const serviceB = {};
  const generationA = beginOpenCodeUsageProjectionRequest(serviceA, "provider-a");
  const generationB = beginOpenCodeUsageProjectionRequest(serviceA, "provider-b");
  const snapshotA = createSnapshot({ providerId: "provider-a" });
  const snapshotB = createSnapshot({ providerId: "provider-b", percentage: 20 });

  assert.equal(
    commitOpenCodeUsageProjection({
      service: serviceA,
      providerId: "provider-a",
      generation: generationA,
      projection: { lastGood: snapshotA, error: null, hint: null },
    }),
    true,
  );
  assert.equal(
    commitOpenCodeUsageProjection({
      service: serviceA,
      providerId: "provider-b",
      generation: generationB,
      projection: {
        lastGood: snapshotB,
        error: null,
        hint: { cookieTail: "b1b2", workspaceId: "wrk_provider-b" },
      },
    }),
    true,
  );

  assert.equal(readOpenCodeUsageProjection(serviceA, "provider-a")?.lastGood, snapshotA);
  assert.equal(readOpenCodeUsageProjection(serviceA, "provider-b")?.lastGood, snapshotB);
  assert.equal(readOpenCodeUsageProjection(serviceA, "provider-c"), null);
  assert.equal(readOpenCodeUsageProjection(serviceB, "provider-a"), null);
});

test("新 generation 开始后旧响应不能提交", () => {
  const service = {};
  const oldGeneration = beginOpenCodeUsageProjectionRequest(service, "provider-a");
  const newGeneration = beginOpenCodeUsageProjectionRequest(service, "provider-a");

  assert.equal(
    isCurrentOpenCodeUsageProjectionRequest(service, "provider-a", oldGeneration),
    false,
  );
  assert.equal(isCurrentOpenCodeUsageProjectionRequest(service, "provider-a", newGeneration), true);
  assert.equal(
    commitOpenCodeUsageProjection({
      service,
      providerId: "provider-a",
      generation: oldGeneration,
      projection: {
        lastGood: createSnapshot({ providerId: "provider-a" }),
        error: null,
        hint: null,
      },
    }),
    false,
  );
  assert.equal(readOpenCodeUsageProjection(service, "provider-a"), null);
});

test("普通错误保留同 provider last-good 并更新错误和 hint", () => {
  const previousSnapshot = createSnapshot({ providerId: "provider-a", percentage: 10 });
  const previous = {
    lastGood: previousSnapshot,
    error: null,
    hint: { cookieTail: "1234", workspaceId: "wrk_provider-a" },
  };

  assert.deepEqual(
    projectOpenCodeUsageResponse({
      previous,
      snapshot: createSnapshot({
        providerId: "provider-a",
        error: "unavailable",
        withWindows: false,
      }),
      hint: { cookieTail: "5678", workspaceId: "wrk_provider-a" },
    }),
    {
      lastGood: previousSnapshot,
      error: "unavailable",
      hint: { cookieTail: "5678", workspaceId: "wrk_provider-a" },
    },
  );
});

test("host 错误快照携带窗口时作为 renderer last-good 投影", () => {
  const errorSnapshot = createSnapshot({
    providerId: "provider-a",
    fetchedAt: 2_000,
    error: "credential-stale",
    percentage: 30,
  });

  assert.deepEqual(
    projectOpenCodeUsageResponse({ previous: null, snapshot: errorSnapshot, hint: null }),
    {
      lastGood: errorSnapshot,
      error: "credential-stale",
      hint: null,
    },
  );
});

test("not-configured 返回空投影，清除后旧请求不能回填", () => {
  const service = {};
  const generation = beginOpenCodeUsageProjectionRequest(service, "provider-a");
  assert.equal(
    commitOpenCodeUsageProjection({
      service,
      providerId: "provider-a",
      generation,
      projection: {
        lastGood: createSnapshot({ providerId: "provider-a" }),
        error: null,
        hint: { cookieTail: "1234", workspaceId: "wrk_provider-a" },
      },
    }),
    true,
  );

  assert.equal(
    projectOpenCodeUsageResponse({
      previous: readOpenCodeUsageProjection(service, "provider-a"),
      snapshot: createSnapshot({ providerId: "provider-a", error: "not-configured" }),
      hint: null,
    }),
    null,
  );
  clearOpenCodeUsageProjection(service, "provider-a");
  assert.equal(readOpenCodeUsageProjection(service, "provider-a"), null);
  assert.equal(
    commitOpenCodeUsageProjection({
      service,
      providerId: "provider-a",
      generation,
      projection: {
        lastGood: createSnapshot({ providerId: "provider-a" }),
        error: null,
        hint: { cookieTail: "1234", workspaceId: "wrk_provider-a" },
      },
    }),
    false,
  );
});

test("invalidate 保留展示值但使旧请求失效", () => {
  const service = {};
  const generation = beginOpenCodeUsageProjectionRequest(service, "provider-a");
  const snapshot = createSnapshot({ providerId: "provider-a" });
  commitOpenCodeUsageProjection({
    service,
    providerId: "provider-a",
    generation,
    projection: { lastGood: snapshot, error: null, hint: null },
  });

  invalidateOpenCodeUsageProjection(service, "provider-a");

  assert.equal(readOpenCodeUsageProjection(service, "provider-a")?.lastGood, snapshot);
  assert.equal(
    commitOpenCodeUsageProjection({
      service,
      providerId: "provider-a",
      generation,
      projection: { lastGood: null, error: "unavailable", hint: null },
    }),
    false,
  );
});
