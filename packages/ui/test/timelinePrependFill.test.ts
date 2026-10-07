import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const timelineSource = readFileSync(
  new URL("../src/v4/ConversationTimeline.tsx", import.meta.url),
  "utf8",
);
const fillSource = readFileSync(
  new URL("../src/v4/timelineWindowFill.ts", import.meta.url),
  "utf8",
);

/**
 * 上滚补页填充条件的接线断言（docs/specs/conversation-timeline-turn-window-fill.md 规则 11）。
 *
 * 行为要整套 DOM + store 才能跑，而真正会咬人的是接线：闸门忘了带填充条件，巨轮就被
 * 分批提交、「工具 N 次」当面上涨；填充循环忘了 staging 守卫，两条路径会互相踩游标；
 * 中断忘了消费，fetch-failed 的放行会变成常开闸门。这些都是「代码读起来对、跑起来错」
 * 的缺陷，用源码断言钉住（与 timelinePrependGateWiring 同一写法）。
 */

test("staged wrapper 必须带 data-staged-turn 标记：填充测量的定位依据", () => {
  assert.match(
    timelineSource,
    /data-staged-turn=\{staged \? "true" : undefined\}/,
    "只有 staged 节点带标记，committed 节点不得命中测量循环",
  );
});

test("填充循环必须被 staging 守卫：两条取数驱动路径不得同时驱动 loadOlder", () => {
  // staging 期间的 pendingOlder 是首绘补齐事务，由首绘判定驱动；上滚循环若无守卫，
  // 会与 runFirstPaintMount 互相踩游标。
  const loopStart = timelineSource.indexOf("shouldContinueTimelinePrependFill({");
  assert.notEqual(loopStart, -1, "找不到填充循环判定");
  const effectStart = timelineSource.lastIndexOf("useLayoutEffect(() => {", loopStart);
  const guard = timelineSource.slice(effectStart, loopStart);
  assert.match(
    guard,
    /if \(stagingActiveRef\.current\) return;/,
    "填充循环 effect 开头必须先让位给 staging",
  );
});

test("填充循环的取页必须经纯函数判定：不许看到缓冲非空就直接 loadOlder", () => {
  assert.match(
    timelineSource,
    /shouldContinueTimelinePrependFill\(\{[\s\S]*?bufferOldestRowKind: pendingOlderRows\?\.\[0\]\?\.kind \?\? null,[\s\S]*?\}\)/,
    "循环必须把 staged 高度、视口、hasMore 与缓冲最老行 kind 一起交给纯函数",
  );
});

test("闸门放行条件必须并入填充条件：位置∧（铺满一屏且整轮到齐）", () => {
  const requestStart = timelineSource.indexOf("gate.request(");
  assert.notEqual(requestStart, -1);
  const requestBlock = timelineSource.slice(requestStart, requestStart + 900);
  assert.match(
    requestBlock,
    /!stagingActive && hasPendingOlder && \(fillReady \|\| fetchFailedInterruptPending\)/,
    "闸门 request 第一参数必须是 staging 守卫 ∧ 缓冲 ∧（填充就绪 ∨ fetch-failed 中断）",
  );
});

test("闸门的 fillReady 必须来自 isTimelinePrependFillCommitReady", () => {
  assert.match(
    timelineSource,
    /const fillReady = isTimelinePrependFillCommitReady\(\{/,
    "放行判定必须复用与填充循环同一份纯函数，不许两处各写一套",
  );
});

test("fetch-failed 中断放行必须是一次性的：提交时消费水位", () => {
  assert.match(
    timelineSource,
    /interrupt\.kind === "fetch-failed" &&\s*\n\s*interrupt\.seq !== consumedOlderFillInterruptSeqRef\.current/,
    "放行条件必须带未消费判定",
  );
  assert.match(
    timelineSource,
    /consumedOlderFillInterruptSeqRef\.current = olderFillInterruptRef\.current\.seq;/,
    "runPrependCommit 末尾必须推进消费水位，否则中断放行变成常开闸门",
  );
});

test("闸门 effect 依赖必须覆盖填充输入与中断信号", () => {
  const anchor = "gate.request(";
  const start = timelineSource.indexOf(anchor);
  const depsStart = timelineSource.indexOf("}, [", start);
  const depsEnd = timelineSource.indexOf("]);", depsStart);
  const deps = timelineSource
    .slice(depsStart + 4, depsEnd)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const required of [
    "windowEpoch",
    "hasPendingOlder",
    "stagingActive",
    "prependFillStagedHeightPx",
    "pendingOlderRows",
    "olderFillInterruptedSeq",
    "olderFillInterruptKind",
  ]) {
    assert.ok(
      deps.includes(required),
      `闸门 effect 依赖缺 ${required}，实际：${JSON.stringify(deps)}`,
    );
  }
});

test("store 的丢弃路径必须 bump 中断信号：静默 return 就是死锁", () => {
  const storeSource = readFileSync(
    new URL("../src/v4/conversationProjectionStore.ts", import.meta.url),
    "utf8",
  );
  // 纪元不匹配与锚点失配两个丢弃分支都必须调 noteOlderPageDiscarded。
  const epochBranch = storeSource.indexOf("rows/range 纪元不匹配");
  assert.notEqual(epochBranch, -1);
  const epochBlock = storeSource.slice(epochBranch, epochBranch + 300);
  assert.match(epochBlock, /noteOlderPageDiscarded\(\);/, "纪元不匹配分支必须 bump 信号");
  const anchorBranch = storeSource.indexOf("transactionAnchorRowId");
  const anchorCall = storeSource.indexOf("noteOlderPageDiscarded();", anchorBranch);
  assert.notEqual(anchorCall, -1, "锚点失配分支必须 bump 信号");
});

test("纯函数口径：未到齐（巨轮拆轮中段）即使铺满一屏也不放行", () => {
  // 直接对模块源码断言条件顺序：hasMore=false 短路一切，高度未排版不放行，
  // 不足一屏不放行，最后才是整轮到齐。
  assert.match(
    fillSource,
    /if \(!input\.hasMoreOlder\) return true;[\s\S]*?if \(input\.stagedHeightPx <= 0 \|\| input\.viewportHeightPx <= 0\) return false;[\s\S]*?if \(input\.stagedHeightPx < input\.viewportHeightPx\) return false;[\s\S]*?return isTimelinePrependFillTurnAligned\(input\);/,
  );
});
