import assert from "node:assert/strict";
import test from "node:test";
import { resolveResumeTargetRecoveryKind } from "../src/runtime/methods/resume.js";

// 会话恢复才收口崩溃残留的 Goal。刚提交、续跑还没登记 turn 的形态
// （active 且尚无 run 租约）与崩溃僵尸同形，所以判定必须挂在恢复入口，
// 不能挂在活会话读取上。

test("active 且没有 run 租约：恢复时按僵尸收口", () => {
  assert.equal(
    resolveResumeTargetRecoveryKind({ status: "active" }),
    "orphaned",
  );
});

test("active 且仍挂着未完成的 run：恢复时按中断收口", () => {
  assert.equal(
    resolveResumeTargetRecoveryKind({
      status: "active",
      activeInputId: "input-1",
      activeRunStartedAtMs: 1_700_000_000_000,
    }),
    "interrupted",
  );
});

test("已经 paused / complete：恢复时不动", () => {
  assert.equal(resolveResumeTargetRecoveryKind({ status: "paused" }), undefined);
  assert.equal(resolveResumeTargetRecoveryKind({ status: "complete" }), undefined);
});

test("租约字段残缺：不误判为可收口组合", () => {
  assert.equal(
    resolveResumeTargetRecoveryKind({
      status: "active",
      activeInputId: "input-1",
    }),
    undefined,
  );
  assert.equal(
    resolveResumeTargetRecoveryKind({
      status: "active",
      activeRunStartedAtMs: 1_700_000_000_000,
    }),
    undefined,
  );
});
