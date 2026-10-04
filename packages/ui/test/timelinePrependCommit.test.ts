import assert from "node:assert/strict";
import test from "node:test";
import {
  PREPEND_COMMIT_TOP_EPSILON_PX,
  TimelinePrependCommitGate,
  isTimelineAtTop,
  isTimelinePrependScrollLocked,
  timelineTopInsetAdjustment,
  type TimelinePrependCommitScheduler,
} from "../src/v4/timelinePrependCommit.js";

/** 假时钟 + 假定时器：只保留每个时刻最后一个排程，与浏览器 setTimeout 语义一致。 */
function createFakeScheduler() {
  let nowMs = 1_000;
  let pending: { at: number; callback: () => void } | null = null;
  const scheduler: TimelinePrependCommitScheduler = {
    schedule: (callback, delayMs) => {
      const at = nowMs + delayMs;
      pending = { at, callback };
      return () => {
        if (pending?.at === at) pending = null;
      };
    },
  };
  return {
    scheduler,
    get now() {
      return nowMs;
    },
    /** 推进时钟，依次触发到点的排程。 */
    advance(ms: number): void {
      const target = nowMs + ms;
      while (pending !== null && pending.at <= target) {
        const next = pending;
        pending = null;
        nowMs = next.at;
        next.callback();
      }
      nowMs = target;
    },
    get scheduledAt(): number | null {
      return pending?.at ?? null;
    },
  };
}

// ── 顶部位置条件 ──

test("只有 scrollTop 归零才算到顶，容差为亚像素级", () => {
  assert.equal(isTimelineAtTop(0), true);
  assert.equal(isTimelineAtTop(PREPEND_COMMIT_TOP_EPSILON_PX), true);
  assert.equal(isTimelineAtTop(PREPEND_COMMIT_TOP_EPSILON_PX + 0.5), false);
  assert.equal(isTimelineAtTop(600), false);
  // NaN 不能被当成「在顶部」而放行提交。
  assert.equal(isTimelineAtTop(Number.NaN), false);
});

test("不在顶部时不排程提交，也不空转", () => {
  const clock = createFakeScheduler();
  const gate = new TimelinePrependCommitGate(clock.scheduler);
  let commits = 0;
  // 停在半路（一个视口之外）。
  gate.noteScroll(600);
  gate.request(true, () => {
    commits += 1;
  });
  assert.equal(clock.scheduledAt, null, "不在顶部就没有排程，不该空转");
  clock.advance(10_000);
  assert.equal(commits, 0);
});

test("滑到顶部后立即排程，不再等任何时间窗口", () => {
  const clock = createFakeScheduler();
  const gate = new TimelinePrependCommitGate(clock.scheduler);
  let commits = 0;
  gate.noteScroll(600);
  gate.request(true, () => {
    commits += 1;
  });
  clock.advance(16);
  gate.noteScroll(0);
  clock.advance(0);
  assert.equal(commits, 1, "到顶即就绪，等待时长不参与正确性");
});

test("请求经过一个 task 才执行，不在调用方栈上直接跑", () => {
  // 调用方可能是 React 的 passive effect，提交要用 flushSync，在那里直接调用会触发
  // React 的「flushSync was called from inside a lifecycle method」告警。
  const clock = createFakeScheduler();
  const gate = new TimelinePrependCommitGate(clock.scheduler);
  let commits = 0;
  gate.request(true, () => {
    commits += 1;
  });
  assert.equal(commits, 0, "排程不等于执行");
  clock.advance(0);
  assert.equal(commits, 1);
});

test("到顶后滑走则提交被撤掉，回到顶部再来", () => {
  const clock = createFakeScheduler();
  const gate = new TimelinePrependCommitGate(clock.scheduler);
  let commits = 0;
  gate.request(true, () => {
    commits += 1;
  });
  gate.noteScroll(0);
  assert.notEqual(clock.scheduledAt, null, "在顶部时应已排程");
  gate.noteScroll(120);
  assert.equal(clock.scheduledAt, null, "离开顶部后不该留着排程");
  clock.advance(0);
  assert.equal(commits, 0);
  gate.noteScroll(0);
  clock.advance(0);
  assert.equal(commits, 1);
});

test("从未滚过时按在顶部处理，内容不足一屏的补页不会永远卡住", () => {
  const clock = createFakeScheduler();
  const gate = new TimelinePrependCommitGate(clock.scheduler);
  let commits = 0;
  gate.request(true, () => {
    commits += 1;
  });
  clock.advance(0);
  assert.equal(commits, 1);
});

// ── request 附带布局对账：账本可能过期（内容收缩时的 clamp、无事件的钳制、
// guard 归类），effects 阶段读到的容器实时 scrollTop 就是布局终值 ──

test("账本残留过期非顶值但布局在顶：对账一次即放行提交", () => {
  // 复现：滚过一次后内容折叠到不足一屏，没有 scroll 事件纠正账本；
  // 闸门 effect 随 hasPendingOlder 重跑时传入容器实时 scrollTop=0，对账后排程。
  const clock = createFakeScheduler();
  const gate = new TimelinePrependCommitGate(clock.scheduler);
  let commits = 0;
  const commit = () => {
    commits += 1;
  };
  gate.noteScroll(600);
  gate.request(true, commit, 0);
  assert.notEqual(clock.scheduledAt, null, "对账读到布局在顶就该排程");
  clock.advance(0);
  assert.equal(commits, 1);
});

test("账本在顶但布局已离顶：对账后不放行，不回退", () => {
  // 反方向同样生效：用户已经滑走但新事件还没派发时，不能把上一轮的「已到顶」当成提交依据。
  const clock = createFakeScheduler();
  const gate = new TimelinePrependCommitGate(clock.scheduler);
  let commits = 0;
  gate.noteScroll(0);
  gate.request(true, () => {
    commits += 1;
  }, 600);
  assert.equal(clock.scheduledAt, null, "对账读到布局离顶就不该排程");
  clock.advance(10_000);
  assert.equal(commits, 0);
});

test("对账参数是 undefined/NaN 时沿用账本，不动既有语义", () => {
  const clock = createFakeScheduler();
  const gate = new TimelinePrependCommitGate(clock.scheduler);
  let commits = 0;
  const commit = () => {
    commits += 1;
  };
  // 容器未挂载时调用方传 undefined：此前滚过、停在半路，仍不排程。
  gate.noteScroll(600);
  gate.request(true, commit, undefined);
  assert.equal(clock.scheduledAt, null);
  // NaN 同样不能被当成「在顶部」而放行。
  gate.request(true, commit, Number.NaN);
  assert.equal(clock.scheduledAt, null);
  clock.advance(10_000);
  assert.equal(commits, 0);
  // 沿用账本的路径仍可被后续真实 scroll 纠正。
  gate.noteScroll(0);
  clock.advance(0);
  assert.equal(commits, 1);
});

test("缓冲为空时调用方不排程：request(false) 不空转", () => {
  // 闸门只看「有得提交吗」。hasPending=false 时调用方 request(false)，
  // 既不排程也不空转；pending 到达后 request(true) 立刻排程。staged 的
  // 「已渲染」构造性成立（effects 阶段 staged DOM 必已挂载），不设独立就绪状态——
  // 会倒退的就绪布尔曾在切会话后永久卡死（EMPTY 常量让就绪 effect 不再触发）。
  const clock = createFakeScheduler();
  const gate = new TimelinePrependCommitGate(clock.scheduler);
  let commits = 0;
  const commit = () => {
    commits += 1;
  };
  gate.request(false, commit);
  gate.noteScroll(0);
  assert.equal(clock.scheduledAt, null);
  clock.advance(10_000);
  assert.equal(commits, 0);
  // pending 到达后调用方 request(true)，立刻排程。
  gate.request(true, commit);
  clock.advance(0);
  assert.equal(commits, 1);
});

test("缓冲清空后取消排程，晚到的排程不会再提交", () => {
  const clock = createFakeScheduler();
  const gate = new TimelinePrependCommitGate(clock.scheduler);
  let commits = 0;
  gate.request(true, () => {
    commits += 1;
  });
  gate.noteScroll(0);
  assert.notEqual(clock.scheduledAt, null);
  gate.request(false, () => {
    commits += 1;
  });
  assert.equal(clock.scheduledAt, null, "取消后不该还留着排程");
  clock.advance(10_000);
  assert.equal(commits, 0);
});

test("cancel 之后到点的排程被撤掉", () => {
  const clock = createFakeScheduler();
  const gate = new TimelinePrependCommitGate(clock.scheduler);
  let commits = 0;
  gate.request(true, () => {
    commits += 1;
  });
  gate.noteScroll(0);
  gate.cancel();
  clock.advance(10_000);
  assert.equal(commits, 0);
});

test("commit 内部重新 request 时不会把同一份内容提交两次", () => {
  const clock = createFakeScheduler();
  const gate = new TimelinePrependCommitGate(clock.scheduler);
  let commits = 0;
  let bufferOccupied = true;
  const commit = () => {
    commits += 1;
    // 模拟 store 提交后触发新一轮排程：内容已落进窗口，缓冲随之清空。
    bufferOccupied = false;
    gate.request(bufferOccupied, commit);
  };
  gate.request(true, commit);
  clock.advance(0);
  assert.equal(commits, 1);
  clock.advance(10_000);
  assert.equal(commits, 1);
});

test("反复 request 只保留最后一次回调，不叠加排程", () => {
  const clock = createFakeScheduler();
  const gate = new TimelinePrependCommitGate(clock.scheduler);
  const fired: string[] = [];
  gate.request(true, () => fired.push("stale"));
  gate.noteScroll(0);
  gate.request(true, () => fired.push("fresh"));
  clock.advance(10_000);
  assert.deepEqual(fired, ["fresh"]);
});

// ── 滚动锁：锁的起点必须是「抵达顶部」，不是「取数开始」 ──

test("取数刚开始、用户还在半路时不上锁", () => {
  // 预取提前两个视口发出。若这时就上锁，用户会在离顶两屏处被冻住、再也上不去；
  // 闸门要求到顶，位置条件恒假，提交永不发生，锁也就永不释放。
  assert.equal(isTimelinePrependScrollLocked(true, false), false);
});

test("没有缓冲时不锁，哪怕已经在顶部", () => {
  assert.equal(isTimelinePrependScrollLocked(false, true), false);
});

test("有缓冲且已抵达顶部才上锁", () => {
  // 「用户看到占位块」正是抵达顶部那一刻，所以锁的起点也正是那一刻。
  assert.equal(isTimelinePrependScrollLocked(true, true), true);
});

test("锁与顶部条件不会互相把对方锁死：到位后两者同时成立", () => {
  // 用户一路滚到顶时，闸门的 atTop() 与锁的 reachedTop 读的是同一个 scrollTop，
  // 所以「能提交」和「已上锁」必然同时到达，不存在只满足其一的中间态。
  const reachedTop = isTimelineAtTop(0);
  assert.equal(isTimelinePrependScrollLocked(true, reachedTop), true);
});

// ── 顶部 inset 补偿 ──

test("占位块出现时 scrollTop 同步下移同样高度，下方内容视觉不动", () => {
  // 视觉位置 = inset + contentOffset - scrollTop。inset 由 0 变 56，要视觉不变就得
  // scrollTop 也 +56；写少了内容被推下，写多了内容被拽上。
  assert.equal(timelineTopInsetAdjustment(0, 56), 56);
});

test("占位块消失时 scrollTop 同步上移同样高度", () => {
  assert.equal(timelineTopInsetAdjustment(56, 0), -56);
});

test("inset 未变时不该产生任何写入", () => {
  assert.equal(timelineTopInsetAdjustment(56, 56), 0);
  assert.equal(timelineTopInsetAdjustment(0, 0), 0);
});

test("提交那一刻：现有 prepend 补偿给 Δ，inset 项补上 -h，合起来正好是 Δ-h", () => {
  // 锚点绝对位置从 h+S 变成 S+Δ，视觉不变要求 scrollTop += Δ + (0 - h)。
  const prependDelta = 400;
  const slotPx = 56;
  const total = prependDelta + timelineTopInsetAdjustment(slotPx, 0);
  assert.equal(total, 344);
  // 只写 prepend 补偿会多写 56，正文在提交瞬间上跳一个占位块的高度。
  assert.notEqual(total, prependDelta);
});
