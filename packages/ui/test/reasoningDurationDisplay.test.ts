import assert from "node:assert/strict";
import test from "node:test";
import {
  reasoningDurationSeconds,
  reasoningDurationSecondsFromMs,
} from "../src/v4/reasoningDurationDisplay.js";

// 这个模块存在的唯一理由：思考秒数必须只由「行数据 + 当前时刻」决定。
// 一旦推导里混入组件挂载时刻，切会话/列表回收重建组件就会让数字归零变小。
// 所以下面的用例里刻意没有挂载时刻这个输入，而是直接断言「同一个 now 换多少次调用都一样」。

const START = 1_700_000_000_000;

test("毫秒转秒向上取整，且不出现 0 秒", () => {
  assert.equal(reasoningDurationSecondsFromMs(0), 1);
  assert.equal(reasoningDurationSecondsFromMs(1), 1);
  assert.equal(reasoningDurationSecondsFromMs(999), 1);
  assert.equal(reasoningDurationSecondsFromMs(1000), 1);
  assert.equal(reasoningDurationSecondsFromMs(1001), 2);
  assert.equal(reasoningDurationSecondsFromMs(2500), 3);
});

test("思考中按行的 createdAt 起算，而不是任何挂载时刻", () => {
  const now = START + 7_400;
  assert.equal(
    reasoningDurationSeconds({ createdAt: START, durationMs: undefined, streaming: true, now }),
    8,
  );
});

test("同一时刻重复推导结果一致（重建组件不会让数字变小）", () => {
  const now = START + 12_000;
  const once = reasoningDurationSeconds({
    createdAt: START,
    durationMs: undefined,
    streaming: true,
    now,
  });
  const afterRemount = reasoningDurationSeconds({
    createdAt: START,
    durationMs: undefined,
    streaming: true,
    now,
  });
  assert.equal(once, 12);
  assert.equal(afterRemount, once);
});

test("时间往前走，数字只增不减", () => {
  const samples = [0, 500, 1_000, 1_001, 5_000].map((elapsed) =>
    reasoningDurationSeconds({
      createdAt: START,
      durationMs: undefined,
      streaming: true,
      now: START + elapsed,
    }),
  );
  for (let index = 1; index < samples.length; index += 1) {
    assert.ok(samples[index]! >= samples[index - 1]!);
  }
  assert.deepEqual(samples, [1, 1, 1, 2, 5]);
});

test("闭合值优先，且与闭合前的直播值同量，不跳变", () => {
  const closedAt = START + 8_200;
  const live = reasoningDurationSeconds({
    createdAt: START,
    durationMs: undefined,
    streaming: true,
    now: closedAt,
  });
  const closed = reasoningDurationSeconds({
    createdAt: START,
    durationMs: closedAt - START,
    streaming: false,
    now: closedAt,
  });
  assert.equal(live, closed);
  assert.equal(closed, 9);
});

test("闭合后 now 继续走，数字不动", () => {
  const durationMs = 8_200;
  const atClose = reasoningDurationSeconds({
    createdAt: START,
    durationMs,
    streaming: false,
    now: START + durationMs,
  });
  const anHourLater = reasoningDurationSeconds({
    createdAt: START,
    durationMs,
    streaming: false,
    now: START + 3_600_000,
  });
  assert.equal(atClose, 9);
  assert.equal(anHourLater, atClose);
});

test("闭合但缺 durationMs 的旧快照显示兜底文案，不随时间增长", () => {
  assert.equal(
    reasoningDurationSeconds({
      createdAt: START,
      durationMs: undefined,
      streaming: false,
      now: START + 60_000,
    }),
    undefined,
  );
});

test("缺 createdAt 的运行中行不猜起点", () => {
  assert.equal(
    reasoningDurationSeconds({
      createdAt: undefined,
      durationMs: undefined,
      streaming: true,
      now: START,
    }),
    undefined,
  );
});

test("极短思考也显示 1 秒", () => {
  assert.equal(
    reasoningDurationSeconds({
      createdAt: START,
      durationMs: 120,
      streaming: false,
      now: START + 120,
    }),
    1,
  );
});
