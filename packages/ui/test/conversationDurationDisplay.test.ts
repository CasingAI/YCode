import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationDurationSeconds,
  conversationDurationSecondsFromMs,
  formatDurationLabel,
  type DurationMessageFormatter,
} from "../src/v4/conversationDurationDisplay.js";

// 这个模块存在的唯一理由：行耗时必须只由「行数据 + 当前时刻」决定。
// 一旦推导里混入组件挂载时刻，切会话/列表回收重建组件就会让数字归零变小。
// 所以下面的用例里刻意没有挂载时刻这个输入，而是直接断言「同一个 now 换多少次调用都一样」。
//
// 思考行传 startedAt = row.createdAt，工具行传 row.startedAt；两者共用同一套推导，
// 见 docs/specs/reasoning-duration.md 与 docs/specs/tool-call-duration.md。

const START = 1_700_000_000_000;

test("毫秒转秒向上取整，且不出现 0 秒", () => {
  assert.equal(conversationDurationSecondsFromMs(0), 1);
  assert.equal(conversationDurationSecondsFromMs(1), 1);
  assert.equal(conversationDurationSecondsFromMs(999), 1);
  assert.equal(conversationDurationSecondsFromMs(1000), 1);
  assert.equal(conversationDurationSecondsFromMs(1001), 2);
  assert.equal(conversationDurationSecondsFromMs(2500), 3);
});

test("运行中按行的 startedAt 起算，而不是任何挂载时刻", () => {
  const now = START + 7_400;
  assert.equal(
    conversationDurationSeconds({ startedAt: START, durationMs: undefined, running: true, now }),
    8,
  );
});

test("同一时刻重复推导结果一致（重建组件不会让数字变小）", () => {
  const now = START + 12_000;
  const once = conversationDurationSeconds({
    startedAt: START,
    durationMs: undefined,
    running: true,
    now,
  });
  const afterRemount = conversationDurationSeconds({
    startedAt: START,
    durationMs: undefined,
    running: true,
    now,
  });
  assert.equal(once, 12);
  assert.equal(afterRemount, once);
});

test("时间往前走，数字只增不减", () => {
  const samples = [0, 500, 1_000, 1_001, 5_000].map((elapsed) =>
    conversationDurationSeconds({
      startedAt: START,
      durationMs: undefined,
      running: true,
      now: START + elapsed,
    }),
  );
  for (let index = 1; index < samples.length; index += 1) {
    assert.ok(samples[index]! >= samples[index - 1]!);
  }
  assert.deepEqual(samples, [1, 1, 1, 2, 5]);
});

test("闭合值优先，且与闭合前的运行值同量，不跳变", () => {
  const closedAt = START + 8_200;
  const live = conversationDurationSeconds({
    startedAt: START,
    durationMs: undefined,
    running: true,
    now: closedAt,
  });
  const closed = conversationDurationSeconds({
    startedAt: START,
    durationMs: closedAt - START,
    running: false,
    now: closedAt,
  });
  assert.equal(live, closed);
  assert.equal(closed, 9);
});

test("闭合后 now 继续走，数字不动", () => {
  const durationMs = 8_200;
  const atClose = conversationDurationSeconds({
    startedAt: START,
    durationMs,
    running: false,
    now: START + durationMs,
  });
  const anHourLater = conversationDurationSeconds({
    startedAt: START,
    durationMs,
    running: false,
    now: START + 3_600_000,
  });
  assert.equal(atClose, 9);
  assert.equal(anHourLater, atClose);
});

test("闭合但缺 durationMs 的旧快照不显示耗时，且不随时间增长", () => {
  assert.equal(
    conversationDurationSeconds({
      startedAt: START,
      durationMs: undefined,
      running: false,
      now: START + 60_000,
    }),
    undefined,
  );
});

test("缺 startedAt 的运行中行不猜起点（工具行从未执行）", () => {
  assert.equal(
    conversationDurationSeconds({
      startedAt: undefined,
      durationMs: undefined,
      running: true,
      now: START,
    }),
    undefined,
  );
});

test("极短耗时也显示 1 秒", () => {
  assert.equal(
    conversationDurationSeconds({
      startedAt: START,
      durationMs: 120,
      running: false,
      now: START + 120,
    }),
    1,
  );
});

test("运行中用「持续了」，结束后用「耗时」", () => {
  const intl: DurationMessageFormatter = {
    formatMessage: ({ id }, values) => `${id}:${String(values?.seconds)}`,
  };
  assert.equal(
    formatDurationLabel(intl, { seconds: 4, running: true }),
    "chat.timeline.duration.running:4",
  );
  assert.equal(
    formatDurationLabel(intl, { seconds: 4, running: false }),
    "chat.timeline.duration.elapsed:4",
  );
});

test("秒数拿不到时不产出文案，调用方整段不渲染", () => {
  const intl: DurationMessageFormatter = {
    formatMessage: ({ id }) => id,
  };
  assert.equal(formatDurationLabel(intl, { seconds: undefined, running: false }), undefined);
  assert.equal(formatDurationLabel(intl, { seconds: undefined, running: true }), undefined);
});
