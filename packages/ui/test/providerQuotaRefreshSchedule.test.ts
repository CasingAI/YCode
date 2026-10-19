import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_QUOTA_REFRESH_DEBOUNCE_MS,
  scheduleProviderQuotaRefresh,
} from "@/settings/model-provider-section/providerQuotaRefreshSchedule.js";

interface FakeTimer {
  id: number;
  delay: number;
  cancelled: boolean;
  fire: () => void;
}

/** 假定时器：clearTimer 之后 fire 不再触发回调，与真实 setTimeout 行为一致。 */
function createFakeTimers() {
  const timers: FakeTimer[] = [];
  return {
    timers,
    setTimer: (handler: () => void, delay: number) => {
      const timer: FakeTimer = {
        id: timers.length + 1,
        delay,
        cancelled: false,
        fire: () => {
          if (timer.cancelled) return;
          handler();
        },
      };
      timers.push(timer);
      return timer.id;
    },
    clearTimer: (handle: unknown) => {
      const timer = timers.find((entry) => entry.id === handle);
      if (timer) timer.cancelled = true;
    },
  };
}

/**
 * 配置变更后的自动重查调度（docs/specs/minimax-quota.md 展示语义第 9 条）：
 * 先建 provider、再填 API Key 时，卡片必须自己再问一次额度，不能让用户
 * 靠切页面或等满 host 的 60s 节流缓存。
 */
test("防抖窗口默认 1s", () => {
  assert.equal(PROVIDER_QUOTA_REFRESH_DEBOUNCE_MS, 1_000);
});

test("调度：到点后触发一次刷新", () => {
  const fake = createFakeTimers();
  let runs = 0;
  scheduleProviderQuotaRefresh({
    run: () => {
      runs += 1;
    },
    setTimer: fake.setTimer,
    clearTimer: fake.clearTimer,
  });

  assert.equal(fake.timers.length, 1);
  assert.equal(fake.timers[0]?.delay, PROVIDER_QUOTA_REFRESH_DEBOUNCE_MS);
  assert.equal(runs, 0);
  fake.timers[0]?.fire();
  assert.equal(runs, 1);
});

test("调度：取消后不再触发", () => {
  const fake = createFakeTimers();
  let runs = 0;
  const schedule = scheduleProviderQuotaRefresh({
    run: () => {
      runs += 1;
    },
    setTimer: fake.setTimer,
    clearTimer: fake.clearTimer,
  });

  schedule.cancel();
  fake.timers[0]?.fire();
  assert.equal(runs, 0);
});

test("调度：连续变更各自独立计时，由调用方用「取消旧的再调新的」合并", () => {
  const fake = createFakeTimers();
  let runs = 0;
  const scheduleRefresh = () =>
    scheduleProviderQuotaRefresh({
      run: () => {
        runs += 1;
      },
      setTimer: fake.setTimer,
      clearTimer: fake.clearTimer,
    });

  const first = scheduleRefresh();
  const second = scheduleRefresh();
  first.cancel();

  // 只有最后一次仍然有效：合并后只触发一次刷新。
  fake.timers[1]?.fire();
  assert.equal(runs, 1);
  assert.equal(fake.timers[0]?.cancelled, true);
  second.cancel();
});
