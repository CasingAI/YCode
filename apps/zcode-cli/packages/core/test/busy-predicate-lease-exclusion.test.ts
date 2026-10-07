import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { hasActiveOrQueuedTurnWork } from "../src/runtime/methods/runtime-command-queue.js";

// specs/message-history-edit.md 规则 18（2026-10-07 修订）：编辑重发的内部抢占
// 持有自身 promotion lease 等待空闲位，busy 判定必须能排除该 lease，否则
// waitForSessionIdle 轮询会看到自己而永远超时；他人 lease 仍算 busy。

function buildRuntimeStub(overrides: Partial<AgentRuntimeInternal> = {}): AgentRuntimeInternal {
  return {
    foregroundPromotionLease: undefined,
    activeForegroundExecution: undefined,
    runtimeCommandDrainActive: false,
    runtimeCommandQueue: { hasPending: () => false },
    activeTurn: undefined,
    activeTurnStartReservation: undefined,
    ...overrides,
  } as unknown as AgentRuntimeInternal;
}

test("完全空闲时 busy 判定为 false，排除参数不影响结果", () => {
  const runtime = buildRuntimeStub();
  assert.equal(hasActiveOrQueuedTurnWork.call(runtime), false);
  assert.equal(
    hasActiveOrQueuedTurnWork.call(runtime, { excludeForegroundPromotionLeaseId: "lease-a" }),
    false,
  );
});

test("仅持有自有 lease：不排除时 busy，排除后空闲", () => {
  const runtime = buildRuntimeStub({
    foregroundPromotionLease: { leaseId: "lease-a", promotedInputId: "cmd-1" },
  });
  assert.equal(hasActiveOrQueuedTurnWork.call(runtime), true);
  assert.equal(
    hasActiveOrQueuedTurnWork.call(runtime, { excludeForegroundPromotionLeaseId: "lease-a" }),
    false,
  );
});

test("持有他人 lease：排除自己的 leaseId 后仍 busy", () => {
  const runtime = buildRuntimeStub({
    foregroundPromotionLease: { leaseId: "lease-other", promotedInputId: "cmd-2" },
  });
  assert.equal(
    hasActiveOrQueuedTurnWork.call(runtime, { excludeForegroundPromotionLeaseId: "lease-mine" }),
    true,
  );
});

test("自有 lease 被排除但其余 busy 信号仍在时仍 busy", () => {
  const busySignals: Array<Partial<AgentRuntimeInternal>> = [
    { activeForegroundExecution: {} as AgentRuntimeInternal["activeForegroundExecution"] },
    { runtimeCommandDrainActive: true },
    { runtimeCommandQueue: { hasPending: () => true } },
    { activeTurn: {} as AgentRuntimeInternal["activeTurn"] },
    { activeTurnStartReservation: {} as AgentRuntimeInternal["activeTurnStartReservation"] },
  ];
  for (const overrides of busySignals) {
    const runtime = buildRuntimeStub({
      foregroundPromotionLease: { leaseId: "lease-a", promotedInputId: "cmd-1" },
      ...overrides,
    });
    assert.equal(
      hasActiveOrQueuedTurnWork.call(runtime, { excludeForegroundPromotionLeaseId: "lease-a" }),
      true,
    );
  }
});
