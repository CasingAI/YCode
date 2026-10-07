import assert from "node:assert/strict";
import test from "node:test";
import type { MiniMaxQuotaSnapshot, MiniMaxQuotaWindow } from "@zcode/shared";
import {
  formatMiniMaxRemainingPercent,
  isMiniMaxWindowNotInPlan,
  toMiniMaxQuotaLines,
} from "@/settings/model-provider-section/minimaxQuotaDisplay.js";
import {
  commitMiniMaxQuotaProjection,
  beginMiniMaxQuotaProjectionRequest,
  projectMiniMaxQuotaResponse,
  readMiniMaxQuotaProjection,
} from "@/hooks/miniMaxQuotaProjectionCache.js";

function windowEntry(overrides: Partial<MiniMaxQuotaWindow> = {}): MiniMaxQuotaWindow {
  return {
    key: "interval",
    remainingPercent: 62,
    resetAt: null,
    status: 1,
    ...overrides,
  };
}

function snapshot(windows: MiniMaxQuotaWindow[]): MiniMaxQuotaSnapshot {
  return {
    providerId: "p1",
    fetchedAt: 1_000,
    windows,
    error: null,
    errorMessage: null,
  };
}

test("toMiniMaxQuotaLines 换算已用占比，status=3 标不在套餐", () => {
  const lines = toMiniMaxQuotaLines([
    windowEntry({ key: "interval", remainingPercent: 62 }),
    windowEntry({ key: "weekly", remainingPercent: 81, status: 3 }),
  ]);
  assert.equal(lines[0]?.usagePercent, 38);
  assert.equal(lines[0]?.notInPlan, false);
  assert.equal(lines[1]?.notInPlan, true);
});

test("isMiniMaxWindowNotInPlan 只认 status === 3", () => {
  assert.equal(isMiniMaxWindowNotInPlan(3), true);
  assert.equal(isMiniMaxWindowNotInPlan(1), false);
  assert.equal(isMiniMaxWindowNotInPlan(2), false);
  assert.equal(isMiniMaxWindowNotInPlan(null), false);
});

test("formatMiniMaxRemainingPercent 按大小取精度", () => {
  assert.equal(formatMiniMaxRemainingPercent(62, "zh-CN"), "62%");
  assert.equal(formatMiniMaxRemainingPercent(9.55, "zh-CN"), "9.6%");
});

test("MiniMax 投影：成功更新窗口，not-configured 清投影", () => {
  const service = {};
  const generation = beginMiniMaxQuotaProjectionRequest(service, "p1");
  const committed = commitMiniMaxQuotaProjection({
    service,
    providerId: "p1",
    generation,
    projection: {
      lastGood: snapshot([windowEntry()]),
      error: null,
    },
  });
  assert.equal(committed, true);
  assert.equal(readMiniMaxQuotaProjection(service, "p1")?.lastGood?.windows.length, 1);

  // 失败保留旧窗口。
  const failed = projectMiniMaxQuotaResponse({
    previous: readMiniMaxQuotaProjection(service, "p1"),
    snapshot: { ...snapshot([]), error: "unavailable" },
  });
  assert.equal(failed?.lastGood?.windows.length, 1);

  // not-configured 清投影。
  assert.equal(
    projectMiniMaxQuotaResponse({
      previous: readMiniMaxQuotaProjection(service, "p1"),
      snapshot: { ...snapshot([]), error: "not-configured" },
    }),
    null,
  );
});
