import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocketConnectionSnapshot } from "@zcode/client";
import {
  BLIP_GRACE_MS,
  resolveConnectionTier,
  type ConnectionTierInput,
} from "../src/connection/connectionStatusTier.js";

function resolve(overrides: Partial<ConnectionTierInput> = {}) {
  return resolveConnectionTier({
    status: "reconnecting",
    disconnectedAt: 0,
    nextRetryAt: 5_000,
    now: 0,
    ...overrides,
  });
}

test("首次连接走 connecting 分支，不复用恢复态文案也不挂进度条", () => {
  const first = resolveConnectionTier({
    status: "connecting",
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
    disconnectedAt: 0,
    nextRetryAt: null,
    now: 30_000,
  });
  assert.equal(closed.tier, "hidden");
});

test("connected 判定为 restored，且不带进度条和重试按钮", () => {
  const recovered = resolveConnectionTier({
    status: "connected",
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

test("退避等待显示倒计时与进度条，可跳过等待立即重试", () => {
  const waiting = resolve({ now: 1_000, nextRetryAt: 6_000 });
  assert.equal(waiting.tier, "waiting");
  assert.equal(waiting.seconds, 5);
  assert.equal(waiting.showProgress, true);
  assert.equal(waiting.showRetryAction, true);
});

test("重连已发起时切换为连接中并撤下进度条和重试按钮", () => {
  const attempting = resolve({ now: 5_000, nextRetryAt: null });
  assert.equal(attempting.tier, "recovering");
  assert.equal(attempting.showProgress, false);
  assert.equal(attempting.showRetryAction, false);
});

test("重试时刻已到但连接管理器尚未发布新阶段时不显示过期倒计时", () => {
  const due = resolve({ now: 5_000, nextRetryAt: 5_000 });
  assert.equal(due.tier, "recovering");
  assert.equal(due.showProgress, false);
  assert.equal(due.showRetryAction, false);
});

test("未来重试时刻的倒计时至少显示 1 秒", () => {
  assert.equal(resolve({ now: 4_900, nextRetryAt: 5_000 }).seconds, 1);
});

test("累计断开时长不覆盖等待阶段", () => {
  const waiting = resolve({ now: 16_000, nextRetryAt: 60_000 });
  assert.equal(waiting.tier, "waiting");
  assert.equal(waiting.showProgress, true);
  assert.equal(waiting.showRetryAction, true);
});

test("累计断开时长不把连接尝试阶段覆盖为等待或手动重试", () => {
  const attempting = resolve({ now: 16_000, nextRetryAt: null });
  assert.equal(attempting.tier, "recovering");
  assert.equal(attempting.showProgress, false);
  assert.equal(attempting.showRetryAction, false);
});

test("断开时刻缺失时仍由重试截止时间决定阶段", () => {
  const orphan = resolve({ disconnectedAt: null, now: 0 });
  assert.equal(orphan.tier, "waiting");
  assert.equal(orphan.showProgress, true);
  assert.equal(orphan.showRetryAction, true);
});

test("直接消费连接管理器发布的完整快照", () => {
  const snapshot: WebSocketConnectionSnapshot = {
    status: "reconnecting",
    generation: 3,
    attempt: 4,
    nextRetryAt: 21_000,
    disconnectedAt: 6_000,
    services: null,
    lastClose: null,
  };
  const result = resolveConnectionTier({
    status: snapshot.status,
    disconnectedAt: snapshot.disconnectedAt,
    nextRetryAt: snapshot.nextRetryAt,
    now: 16_000,
  });
  assert.equal(result.tier, "waiting");
  assert.equal(result.seconds, 5);
  assert.equal(result.showRetryAction, true);
});
