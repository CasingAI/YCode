import assert from "node:assert/strict";
import test from "node:test";
import { resolveOffPeakCreateBlockReason } from "../src/settings/offPeakUiPresentation.js";

test("灰度未命中时不拦截（入口由灰度门整体隐藏）", () => {
  assert.equal(
    resolveOffPeakCreateBlockReason({
      availabilityStatus: "idle",
      canTakeNumber: undefined,
      grayEnabled: false,
      noPlan: false,
    }),
    null,
  );
});

test("灰度命中但依赖未就绪时拦截，创建入口不渲染", () => {
  for (const availabilityStatus of ["loading", "idle", "error"] as const) {
    assert.equal(
      resolveOffPeakCreateBlockReason({
        availabilityStatus,
        canTakeNumber: undefined,
        grayEnabled: true,
        noPlan: false,
      }),
      "unavailable",
    );
  }
});

test("灰度命中但套餐不符时拦截", () => {
  assert.equal(
    resolveOffPeakCreateBlockReason({
      availabilityStatus: "ready",
      canTakeNumber: true,
      grayEnabled: true,
      noPlan: true,
    }),
    "plan",
  );
});

test("取号成功才放行，否则按配额拦截", () => {
  assert.equal(
    resolveOffPeakCreateBlockReason({
      availabilityStatus: "ready",
      canTakeNumber: true,
      grayEnabled: true,
      noPlan: false,
    }),
    null,
  );
  assert.equal(
    resolveOffPeakCreateBlockReason({
      availabilityStatus: "ready",
      canTakeNumber: false,
      grayEnabled: true,
      noPlan: false,
    }),
    "quota",
  );
});
