import assert from "node:assert/strict";
import test from "node:test";
import { isPlanApprovalToolName } from "@zcode/shared/zcode-protocol-v4";

// 计划工具判定是桥接层拒绝豁免、fork 继承、行过滤多处共用的唯一实现：
// 同时接受 CreatePlan 与历史 ExitPlanMode（大小写不敏感），只认工具名、不认形状。
// V1 官方原版与 V2 改版 ExitPlanMode 对兼容层是同一个东西，不做版本分支。

test("CreatePlan 命中", () => {
  assert.equal(isPlanApprovalToolName("CreatePlan"), true);
});

test("历史 ExitPlanMode 命中", () => {
  assert.equal(isPlanApprovalToolName("ExitPlanMode"), true);
});

test("大小写与空白不影响判定", () => {
  assert.equal(isPlanApprovalToolName(" exitplanmode "), true);
  assert.equal(isPlanApprovalToolName("CREATEPLAN"), true);
});

test("普通问答与权限工具不命中", () => {
  assert.equal(isPlanApprovalToolName("AskUserQuestion"), false);
  assert.equal(isPlanApprovalToolName("Bash"), false);
});

test("非字符串与空值不命中", () => {
  assert.equal(isPlanApprovalToolName(undefined), false);
  assert.equal(isPlanApprovalToolName(null), false);
  assert.equal(isPlanApprovalToolName(""), false);
});
