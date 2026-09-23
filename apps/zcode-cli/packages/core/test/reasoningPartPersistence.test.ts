import assert from "node:assert/strict";
import test from "node:test";
import { mergeReasoningForPersistence } from "../src/runtime/methods/reasoning-part-persistence.js";
import {
  getOrCreateReasoningBlock,
  markReasoningBlockEnded,
  readReasoningTiming,
} from "../src/runtime/methods/reasoning-stream.js";
import type { ModelReasoningContentBlock } from "../src/runtime/deps.js";

// 落库粒度是「一次模型请求」：上游按 chunk 把一个 item 切成多个 summary part、一次响应
// 又含多个 item，逐块落盘会让同一轮思考在库里/恢复后/UI 上裂成十几行。这些用例锁住
// 归并规则本身（拼接、窗口、例外），以及例外之外没有别的合并条件。

function newBucket() {
  const reasoning: ModelReasoningContentBlock[] = [];
  const reasoningById = new Map<string, ModelReasoningContentBlock>();
  return { reasoning, reasoningById };
}

function liveBlock(
  bucket: ReturnType<typeof newBucket>,
  id: string,
  text: string,
  providerMetadata?: Record<string, unknown>,
): ModelReasoningContentBlock {
  const block = getOrCreateReasoningBlock({ id, providerMetadata, ...bucket });
  block.text += text;
  return block;
}

const endFromTiming = (block: ModelReasoningContentBlock): number =>
  readReasoningTiming(block)?.endedAt ?? 0;

test("同一轮多个块归并成一条，段间以空行拼接且保持顺序", () => {
  const bucket = newBucket();
  liveBlock(bucket, "item_1:0", "**Analyzing FAT filesystem scanner quirks**");
  liveBlock(bucket, "item_1:1", "Reading the scanner source.");
  liveBlock(bucket, "item_2:0", "Synthesizing next steps.");

  const parts = mergeReasoningForPersistence({
    blocks: bucket.reasoning,
    fallbackStart: 0,
    resolveEnd: endFromTiming,
  });

  assert.equal(parts.length, 1);
  assert.equal(
    parts[0]!.text,
    "**Analyzing FAT filesystem scanner quirks**\n\nReading the scanner source.\n\nSynthesizing next steps.",
  );
});

test("窗口覆盖整段思考：起点取各段最早、终点取各段最晚", () => {
  const bucket = newBucket();
  const first = liveBlock(bucket, "r1", "first");
  const second = liveBlock(bucket, "r2", "second");
  const firstStart = readReasoningTiming(first)!.startedAt;
  const secondStart = readReasoningTiming(second)!.startedAt;
  markReasoningBlockEnded(first, firstStart + 2_000);
  markReasoningBlockEnded(second, secondStart + 5_000);

  const parts = mergeReasoningForPersistence({
    blocks: bucket.reasoning,
    fallbackStart: 999,
    resolveEnd: endFromTiming,
  });

  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.time.start, firstStart);
  assert.equal(parts[0]!.time.end, secondStart + 5_000);
});

test("未登记起点的块（历史回放构造、非流式结果）回退到 fallbackStart", () => {
  const block: ModelReasoningContentBlock = { type: "reasoning", text: "hydrated" };

  const parts = mergeReasoningForPersistence({
    blocks: [block],
    fallbackStart: 1_000,
    resolveEnd: () => 7_000,
  });

  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.time.start, 1_000);
  assert.equal(parts[0]!.time.end, 7_000);
});

test("取消收尾的终点一律取取消当下，不采用 provider 早先发过的 reasoning_end", () => {
  const bucket = newBucket();
  const block = liveBlock(bucket, "r1", "thinking");
  markReasoningBlockEnded(block, readReasoningTiming(block)!.startedAt + 1_000);
  const completedAt = 5_000_000;

  const parts = mergeReasoningForPersistence({
    blocks: bucket.reasoning,
    fallbackStart: 42,
    resolveEnd: () => completedAt,
  });

  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.time.end, completedAt);
});

test("无文本无元数据的空壳不产生 part", () => {
  const bucket = newBucket();
  liveBlock(bucket, "r1", "");

  const parts = mergeReasoningForPersistence({
    blocks: bucket.reasoning,
    fallbackStart: 0,
    resolveEnd: endFromTiming,
  });

  assert.deepEqual(parts, []);
});

test("只有元数据的加密思考不贡献文本，也不额外成行", () => {
  const bucket = newBucket();
  const encrypted: Record<string, unknown> = {
    openai: { itemId: "item_1", reasoningEncryptedContent: "cipher" },
  };
  liveBlock(bucket, "item_1:0", "", encrypted);
  liveBlock(bucket, "item_1:1", "visible summary");

  const parts = mergeReasoningForPersistence({
    blocks: bucket.reasoning,
    fallbackStart: 0,
    resolveEnd: endFromTiming,
  });

  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.text, "visible summary");
  // 归并组保留首块元数据；Responses 该元数据在请求投影边界被整段丢弃，不影响回放。
  assert.deepEqual(parts[0]!.metadata, encrypted);
});

test("整轮只有元数据的加密思考仍落一条空文本 part", () => {
  const bucket = newBucket();
  liveBlock(bucket, "item_1:0", "", {
    openai: { itemId: "item_1", reasoningEncryptedContent: "cipher" },
  });

  const parts = mergeReasoningForPersistence({
    blocks: bucket.reasoning,
    fallbackStart: 0,
    resolveEnd: endFromTiming,
  });

  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.text, "");
  assert.deepEqual(parts[0]!.metadata, {
    openai: { itemId: "item_1", reasoningEncryptedContent: "cipher" },
  });
});

test("带签名的 thinking 逐块保留，并把前后普通块切成两组", () => {
  const bucket = newBucket();
  liveBlock(bucket, "r1", "before");
  const signedMetadata: Record<string, unknown> = { anthropic: { signature: "sig-1" } };
  liveBlock(bucket, "r2", "signed thinking", signedMetadata);
  liveBlock(bucket, "r3", "after");

  const parts = mergeReasoningForPersistence({
    blocks: bucket.reasoning,
    fallbackStart: 0,
    resolveEnd: endFromTiming,
  });

  assert.deepEqual(
    parts.map((part) => part.text),
    ["before", "signed thinking", "after"],
  );
  assert.deepEqual(parts[1]!.metadata, signedMetadata);
});

test("相邻两个签名块也不合并", () => {
  const bucket = newBucket();
  liveBlock(bucket, "r1", "first", { anthropic: { signature: "sig-1" } });
  liveBlock(bucket, "r2", "second", { anthropic: { signature: "sig-2" } });

  const parts = mergeReasoningForPersistence({
    blocks: bucket.reasoning,
    fallbackStart: 0,
    resolveEnd: endFromTiming,
  });

  assert.deepEqual(
    parts.map((part) => part.text),
    ["first", "second"],
  );
});

test("redacted thinking 单独成条，不与相邻普通块合并", () => {
  const bucket = newBucket();
  liveBlock(bucket, "r1", "before");
  liveBlock(bucket, "r2", "", { anthropic: { redactedData: "opaque-blob" } });

  const parts = mergeReasoningForPersistence({
    blocks: bucket.reasoning,
    fallbackStart: 0,
    resolveEnd: endFromTiming,
  });

  assert.deepEqual(
    parts.map((part) => part.text),
    ["before", ""],
  );
  assert.deepEqual(parts[1]!.metadata, { anthropic: { redactedData: "opaque-blob" } });
});

test("空字符串签名不算签名块，仍参与归并", () => {
  const bucket = newBucket();
  liveBlock(bucket, "r1", "first", { anthropic: { signature: "" } });
  liveBlock(bucket, "r2", "second");

  const parts = mergeReasoningForPersistence({
    blocks: bucket.reasoning,
    fallbackStart: 0,
    resolveEnd: endFromTiming,
  });

  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.text, "first\n\nsecond");
});
