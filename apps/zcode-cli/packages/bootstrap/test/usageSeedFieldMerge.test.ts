import assert from "node:assert/strict";
import test from "node:test";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

// seedUsage 字段级合并（见 docs/specs/context-usage-stale-display.md）：
// 事件重放已恢复用量水位、但缺缓存字段时，种子必须补齐缓存而非整体跳过。

const SESSION_ID = "sess-usage-seed-merge";

function seed(cache?: { hitRate: number | null }) {
  return {
    contextWindow: {
      usedTokens: 45_300,
      maxTokens: 200_000,
      autoCompactThresholdTokens: null,
      ...(cache ? { cache } : {}),
    },
  };
}

test("seedUsage 在已有用量水位时补齐缺失的缓存字段", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  // 先注入无缓存的用量种子，模拟事件重放已恢复水位。
  projection.seedUsage(seed());
  assert.equal(projection.getSnapshot().usage.contextWindow?.usedTokens, 45_300);
  assert.equal(projection.getSnapshot().usage.contextWindow?.cache, undefined);

  // 同一水位的种子携带缓存：应补齐 cache，不重置用量。
  projection.seedUsage(seed({ hitRate: 0.42 }));
  const contextWindow = projection.getSnapshot().usage.contextWindow;
  assert.equal(contextWindow?.usedTokens, 45_300);
  assert.equal(contextWindow?.maxTokens, 200_000);
  assert.equal(contextWindow?.cache?.hitRate, 0.42);
});

test("seedUsage 不覆盖已存在的缓存字段", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  projection.seedUsage(seed({ hitRate: 0.9 }));
  // 迟到的旧种子带更低命中率：已存在字段不被覆盖。
  projection.seedUsage(seed({ hitRate: 0.1 }));
  assert.equal(projection.getSnapshot().usage.contextWindow?.cache?.hitRate, 0.9);
});
