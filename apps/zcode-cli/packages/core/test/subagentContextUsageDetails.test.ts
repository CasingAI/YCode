import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  buildModelCompleteContextUsageFields,
  querySourceForTask,
  supportsContextUsageDetails,
} from "../src/runtime/methods/turn-model-step-usage.js";

// 子代理只读浮层的"上下文来源明细 + 平均缓存命中率"必须由子会话自己的轮次产出。
// Bug 原因：早期 ModelComplete 只给 main_turn 附带 breakdown / cacheHit，
// 子会话快照因此只有水位，浮层只剩"容量标题 + 单色进度条"，与主会话输入框不一致。

function fakeRuntime(): AgentRuntimeInternal {
  return {
    sessionCacheHitAggregate: {
      requestCount: 0,
      totalInputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
    },
  } as unknown as AgentRuntimeInternal;
}

const BREAKDOWN = [{ source: "messages" as const, chars: 1_200, tokens: 300 }];

test("子会话轮次的 querySource 是 subagent，并携带上下文明细", () => {
  assert.equal(querySourceForTask("subagent_child"), "subagent");
  assert.equal(supportsContextUsageDetails("subagent"), true);
  assert.equal(supportsContextUsageDetails("main_turn"), true);
});

test("子会话轮次产出 breakdown 与 cacheHit，且只累计自己的缓存命中", () => {
  const runtime = fakeRuntime();
  const fields = buildModelCompleteContextUsageFields(runtime, {
    querySource: "subagent",
    usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 500 },
    breakdown: BREAKDOWN,
  });

  assert.deepEqual(fields.contextUsageBreakdown, BREAKDOWN);
  assert.ok(fields.cacheHit, "子会话轮次必须带缓存命中率快照");
  assert.equal(fields.cacheHit.latestHitRate, 0.5);
  assert.equal(fields.cacheHit.hitRate, 0.5);
  assert.equal(fields.cacheHit.hitRateRequestCount, 1);
  // 聚合写在子 runtime 自己的实例上，父会话口径不受影响。
  assert.equal(runtime.sessionCacheHitAggregate.requestCount, 1);
  assert.equal(runtime.sessionCacheHitAggregate.totalCacheReadTokens, 500);
});

test("不支持展示的轮次既不带字段也不累计缓存命中", () => {
  const runtime = fakeRuntime();
  const fields = buildModelCompleteContextUsageFields(runtime, {
    querySource: "tool_internal",
    usage: { inputTokens: 1_000, cacheReadTokens: 500 },
    breakdown: BREAKDOWN,
  });

  assert.deepEqual(fields, {});
  assert.equal(runtime.sessionCacheHitAggregate.requestCount, 0);
});

test("没有明细时只带缓存命中率，不带空明细数组", () => {
  const runtime = fakeRuntime();
  const fields = buildModelCompleteContextUsageFields(runtime, {
    querySource: "subagent",
    usage: { inputTokens: 1_000 },
    breakdown: [],
  });

  assert.equal(fields.contextUsageBreakdown, undefined);
  assert.ok(fields.cacheHit);
});
