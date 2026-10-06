import assert from "node:assert/strict";
import test from "node:test";
import { TimelineRowHeightCache } from "../src/v4/timelineRowHeightCache.js";

/**
 * 测高缓存的传导链：命中的测量直接成为该行的估值，虚拟行首次渲染就是真高度，
 * 不产生 size delta，也就不需要二次 scrollTop 补偿。
 */
const PENDING_KEYS = ["turn-early-1", "turn-early-2", "turn-early-3"];

function createCacheWith(keys: readonly string[], heightPx: number): TimelineRowHeightCache {
  const cache = new TimelineRowHeightCache();
  for (const key of keys) cache.set(key, heightPx);
  return cache;
}

test("量出的高度会直接成为该行的估值，虚拟行首次渲染就是真高度", () => {
  const cache = createCacheWith(PENDING_KEYS, 137);
  // estimateSize 走 heightCache.estimate：命中测量就不回落估值。
  for (const key of PENDING_KEYS) {
    assert.equal(cache.estimate(key, 72), 137);
  }
  assert.notEqual(cache.estimate(PENDING_KEYS[0], 72), 72);
});

test("不同行量出不同高度时各自独立，不被统一值覆盖", () => {
  const cache = new TimelineRowHeightCache();
  cache.set("turn-early-1", 420);
  cache.set("turn-early-2", 88);
  cache.set("turn-early-3", 1_260);
  assert.equal(cache.estimate("turn-early-1", 72), 420);
  assert.equal(cache.estimate("turn-early-2", 72), 88);
  assert.equal(cache.estimate("turn-early-3", 72), 1_260);
});

test("缓存拒收 0 与非有限高度，估值回落兜底值", () => {
  // 拒收 <=0 与非有限值是 estimateSize 的兜底策略：渲染为空的 turn 高度是 0，
  // 缓存收下它只会让 estimate 拿 0 当估值，不如回落默认估值。
  for (const bogus of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
    const cache = new TimelineRowHeightCache();
    for (const key of PENDING_KEYS) cache.set(key, bogus);
    assert.equal(cache.get(PENDING_KEYS[0]), undefined, `${bogus} 不该被缓存收下`);
  }
  const cache = new TimelineRowHeightCache();
  cache.set("turn-early-1", 0);
  assert.equal(cache.estimate("turn-early-1", 72), 72);
});

test("行卸载重挂后高度仍在：测高缓存按 key 持久，不靠 virtualizer 的 measurementsCache", () => {
  // 流式行会持续长高；行在窗口内卸载重挂必须保住已有测量，否则首次重挂又是一轮 delta。
  const cache = createCacheWith(PENDING_KEYS, 200);
  // 模拟一次「卸载再重挂」：组件重建，但缓存实例不变。
  const afterRemount = cache;
  assert.equal(afterRemount.estimate("turn-early-2", 72), 200);
});
