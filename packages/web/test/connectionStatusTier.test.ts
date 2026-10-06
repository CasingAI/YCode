import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocketConnectionSnapshot } from "@zcode/client";
import {
  BLIP_GRACE_MS,
  ESCALATE_AFTER_MS,
  resolveConnectionTier,
  type ConnectionTierInput,
} from "../src/connection/connectionStatusTier.js";

function resolve(overrides: Partial<ConnectionTierInput> = {}) {
  return resolveConnectionTier({
    status: "reconnecting",
    attempt: 1,
    disconnectedAt: 0,
    nextRetryAt: 5_000,
    now: 0,
    ...overrides,
  });
}

test("首次连接走 connecting 分支，不复用恢复态文案也不挂进度条", () => {
  const first = resolveConnectionTier({
    status: "connecting",
    attempt: 0,
    disconnectedAt: null,
    nextRetryAt: null,
    now: 0,
  });
  assert.equal(first.tier, "connecting");
  assert.equal(first.showProgress, false);
  assert.equal(first.showRetryAction, false);
});

test("closed 不渲染任何东西", () => {
  const closed = resolveConnectionTier({
    status: "closed",
    attempt: 3,
    disconnectedAt: 0,
    nextRetryAt: null,
    now: 30_000,
  });
  assert.equal(closed.tier, "hidden");
});

test("connected 判定为 restored，且不带进度条和重试按钮", () => {
  const recovered = resolveConnectionTier({
    status: "connected",
    attempt: 2,
    disconnectedAt: null,
    nextRetryAt: null,
    now: 30_000,
  });
  assert.equal(recovered.tier, "restored");
  assert.equal(recovered.showProgress, false);
  assert.equal(recovered.showRetryAction, false);
});

test("断线不足宽限期不渲染，避免瞬时抖动闪一条横幅", () => {
  const justBroke = resolve({ now: BLIP_GRACE_MS - 1 });
  assert.equal(justBroke.tier, "hidden");

  const pastGrace = resolve({ now: BLIP_GRACE_MS });
  assert.equal(pastGrace.tier, "waiting");
});

test("退避等待显示倒计时与进度条，但不挂重试按钮", () => {
  const waiting = resolve({ now: 1_000, nextRetryAt: 6_000 });
  assert.equal(waiting.tier, "waiting");
  assert.equal(waiting.seconds, 5);
  assert.equal(waiting.showProgress, true);
  assert.equal(waiting.showRetryAction, false);
});

test("正在发起下一次连接时没有剩余时间可等，进度条撤掉", () => {
  const attempting = resolve({ now: 5_000, nextRetryAt: null });
  assert.equal(attempting.tier, "recovering");
  assert.equal(attempting.showProgress, false);
  assert.equal(attempting.showRetryAction, false);
});

test("没有重试定时器在跑时不能报假倒计时", () => {
  // nextRetryAt 为空说明重连已发起、正在等握手结果。
  // 这时候若还渲染「N 秒后自动重连」，那个秒数是编出来的。
  const attempting = resolve({ attempt: 4, now: 5_000, nextRetryAt: null });
  assert.equal(attempting.tier, "recovering");
});

test("倒计时不会显示成 0 秒", () => {
  assert.equal(resolve({ now: 4_900, nextRetryAt: 5_000 }).seconds, 1);
  assert.equal(resolve({ now: 9_000, nextRetryAt: 5_000 }).seconds, 1);
});

test("同一退避内重复失败显示不稳定文案", () => {
  const unstable = resolve({ attempt: 2, now: 1_000, nextRetryAt: 11_000 });
  assert.equal(unstable.tier, "unstable");
  assert.equal(unstable.showProgress, true);
  assert.equal(unstable.showRetryAction, false);
});

test("断开超过升级阈值才出现重试按钮", () => {
  const almost = resolve({ now: ESCALATE_AFTER_MS - 1, nextRetryAt: 60_000 });
  assert.equal(almost.tier, "waiting");
  assert.equal(almost.showRetryAction, false);

  const stalled = resolve({ attempt: 4, now: ESCALATE_AFTER_MS, nextRetryAt: 60_000 });
  assert.equal(stalled.tier, "stalled");
  assert.equal(stalled.showRetryAction, true);
});

test("升级态优先级高于重复失败，不会退回不稳定文案", () => {
  const escalated = resolve({ attempt: 9, now: ESCALATE_AFTER_MS + 1, nextRetryAt: null });
  assert.equal(escalated.tier, "stalled");
  assert.equal(escalated.showRetryAction, true);
});

test("断开时刻缺失时按首次失败处理，不误判成刚断线", () => {
  const orphan = resolve({ disconnectedAt: null, now: 0 });
  assert.equal(orphan.tier, "waiting");
  assert.equal(orphan.showProgress, true);
});

test("直接消费连接管理器发布的完整快照", () => {
  const snapshot: WebSocketConnectionSnapshot = {
    status: "reconnecting",
    generation: 3,
    attempt: 2,
    nextRetryAt: 21_000,
    disconnectedAt: 6_000,
    services: null,
    lastClose: null,
  };
  const result = resolveConnectionTier({
    status: snapshot.status,
    attempt: snapshot.attempt,
    disconnectedAt: snapshot.disconnectedAt,
    nextRetryAt: snapshot.nextRetryAt,
    now: 16_000,
  });
  assert.equal(result.tier, "unstable");
  assert.equal(result.seconds, 5);
});
