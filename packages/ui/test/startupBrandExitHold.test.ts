import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceStartupBrandExitHold,
  createStartupBrandExitHoldState,
  settleStartupBrandExitHold,
  type StartupBrandExitHoldState,
} from "../src/root/startupBrandExitHold.js";

// 退出保持期决定阶段 2 的收尾动画能否被看见：提前结束 = 动画被卸载，
// 回退时不撤销 = 把定格画面当成"加载中"继续显示。两种错法都不会自己暴露出来。

/** 按门控序列推进，返回每一步之后的保持期状态。 */
function walkHoldTimeline(blockedSequence: boolean[]): boolean[] {
  let state: StartupBrandExitHoldState = createStartupBrandExitHoldState(
    blockedSequence[0] ?? false,
  );
  const holds: boolean[] = [];
  for (const blocked of blockedSequence) {
    const step = advanceStartupBrandExitHold(state, blocked);
    state = step.state;
    holds.push(state.isExitHold);
  }
  return holds;
}

test("门控从阻塞转为解除时进入保持期并要求启动计时器", () => {
  const step = advanceStartupBrandExitHold(createStartupBrandExitHoldState(true), false);
  assert.equal(step.state.isExitHold, true);
  assert.equal(step.startSettleTimer, true);
});

test("启动即未阻塞时不进入保持期", () => {
  const step = advanceStartupBrandExitHold(createStartupBrandExitHoldState(false), false);
  assert.equal(step.state.isExitHold, false);
  assert.equal(step.startSettleTimer, false);
});

test("持续阻塞不进入保持期", () => {
  const step = advanceStartupBrandExitHold(createStartupBrandExitHoldState(true), true);
  assert.equal(step.state.isExitHold, false);
  assert.equal(step.startSettleTimer, false);
});

test("保持期内门控回退会撤销保持期（回退 workspace 创建场景）", () => {
  const holds = walkHoldTimeline([true, false, true]);
  assert.deepEqual(holds, [false, true, false]);
});

test("回退后再次解除仍会重新进入保持期", () => {
  const holds = walkHoldTimeline([true, false, true, false]);
  assert.deepEqual(holds, [false, true, false, true]);
});

test("收尾动画播完结束保持期，且不影响后续翻转识别", () => {
  let state = advanceStartupBrandExitHold(createStartupBrandExitHoldState(true), false).state;
  state = settleStartupBrandExitHold(state);
  assert.equal(state.isExitHold, false);
  // 已经解除过，再收到解除不该重新进入保持期。
  assert.equal(advanceStartupBrandExitHold(state, false).startSettleTimer, false);
  // 但重新阻塞再解除，仍应进入保持期。
  const reblocked = advanceStartupBrandExitHold(state, true).state;
  assert.equal(advanceStartupBrandExitHold(reblocked, false).state.isExitHold, true);
});
