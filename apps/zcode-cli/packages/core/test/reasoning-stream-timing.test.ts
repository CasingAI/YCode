import assert from "node:assert/strict";
import test from "node:test";
import {
  getOrCreateReasoningBlock,
  markReasoningBlockEnded,
  readReasoningTiming,
} from "../src/runtime/methods/reasoning-stream.js";
import type { ModelReasoningContentBlock } from "../src/runtime/deps.js";

// 思考块的起止时刻是冷恢复「持续了 N 秒」的唯一来源（落盘时写进 reasoning part 的 time）。
// 这些用例锁住三件事：起点在第一次拿到该段内容时就固定、结束时刻只认第一次、
// 以及承载方式不往块对象上加字段（那些块会回放给 provider）。

function newBucket() {
  const reasoning: ModelReasoningContentBlock[] = [];
  const reasoningById = new Map<string, ModelReasoningContentBlock>();
  return { reasoning, reasoningById };
}

test("建块时即登记起点，同一 id 重复取块不刷新起点", () => {
  const bucket = newBucket();
  const block = getOrCreateReasoningBlock({ id: "r1", ...bucket });
  const timing = readReasoningTiming(block);
  assert.ok(timing);
  assert.equal(timing.endedAt, undefined);
  assert.ok(Math.abs(timing.startedAt - Date.now()) < 5_000);

  const again = getOrCreateReasoningBlock({ id: "r1", ...bucket });
  assert.equal(again, block);
  assert.equal(readReasoningTiming(block)?.startedAt, timing.startedAt);
});

test("同一 id 的 start/delta 复用同一个块，只推入一次", () => {
  const bucket = newBucket();
  const fromStart = getOrCreateReasoningBlock({ id: "r1", ...bucket });
  const fromDelta = getOrCreateReasoningBlock({ id: "r1", ...bucket });
  assert.equal(fromDelta, fromStart);
  assert.equal(bucket.reasoning.length, 1);
});

test("缺 id 的 provider 走默认段，不会为每个 delta 新建块", () => {
  const bucket = newBucket();
  const first = getOrCreateReasoningBlock({ ...bucket });
  const second = getOrCreateReasoningBlock({ ...bucket });
  assert.equal(second, first);
  assert.equal(bucket.reasoning.length, 1);
});

test("结束时刻只认第一次，重复的 reasoning_end 不覆盖", () => {
  const bucket = newBucket();
  const block = getOrCreateReasoningBlock({ id: "r1", ...bucket });
  const startedAt = readReasoningTiming(block)!.startedAt;
  markReasoningBlockEnded(block, startedAt + 4_000);
  markReasoningBlockEnded(block, startedAt + 90_000);
  assert.equal(readReasoningTiming(block)?.endedAt, startedAt + 4_000);
});

test("拿不到结束事件的块保持无 endedAt，由落盘端取当下", () => {
  const bucket = newBucket();
  const block = getOrCreateReasoningBlock({ id: "r1", ...bucket });
  markReasoningBlockEnded(undefined);
  assert.equal(readReasoningTiming(block)?.endedAt, undefined);
});

test("未登记的块（如历史回放构造）读不到时间，落盘端可退回模型步窗口", () => {
  const block: ModelReasoningContentBlock = { type: "reasoning", text: "hi" };
  assert.equal(readReasoningTiming(block), undefined);
  markReasoningBlockEnded(block, Date.now());
  assert.equal(readReasoningTiming(block), undefined);
});

test("时间登记不写进块对象：回放给 provider 的字段保持原样", () => {
  const bucket = newBucket();
  const block = getOrCreateReasoningBlock({ id: "r1", providerMetadata: { k: 1 }, ...bucket });
  markReasoningBlockEnded(block);
  assert.deepEqual(Object.keys(block).sort(), ["providerOptions", "text", "type"]);
});

test("两段连续思考各自独立计时", () => {
  const bucket = newBucket();
  const first = getOrCreateReasoningBlock({ id: "r1", ...bucket });
  markReasoningBlockEnded(first, readReasoningTiming(first)!.startedAt + 2_000);
  const second = getOrCreateReasoningBlock({ id: "r2", ...bucket });
  const secondTiming = readReasoningTiming(second)!;
  assert.equal(secondTiming.endedAt, undefined);
  assert.notEqual(second, first);
  assert.equal(bucket.reasoning.length, 2);
  // 第一段的结束不影响第二段：结束第二段时也不会回头改第一段。
  markReasoningBlockEnded(second, secondTiming.startedAt + 3_000);
  assert.equal(readReasoningTiming(first)?.endedAt, readReasoningTiming(first)!.startedAt + 2_000);
  assert.equal(readReasoningTiming(second)?.endedAt, secondTiming.startedAt + 3_000);
});
