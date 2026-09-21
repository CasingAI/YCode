import assert from "node:assert/strict";
import test from "node:test";
import type { UserInputRequestPayload } from "@zcode/shared/zcode-protocol-v4";
import { isPlanApprovalUserInputRequest } from "../src/lib/planApproval.js";

// 计划批准判定是「静默拒绝」与「通知文案选型」两处共用的唯一实现：
// 必须同时认 toolName 与 schema 两个信号，且不能把普通问答/权限误判进来。

function payload(overrides: Partial<UserInputRequestPayload>): UserInputRequestPayload {
  return {
    kind: "userInput",
    prompt: "",
    freeText: false,
    ...overrides,
  };
}

test("toolName 精确命中 ExitPlanMode", () => {
  assert.equal(isPlanApprovalUserInputRequest(payload({ toolName: "ExitPlanMode" })), true);
});

test("toolName 大小写与空白不影响判定", () => {
  assert.equal(isPlanApprovalUserInputRequest(payload({ toolName: " exitplanmode " })), true);
});

test("schema.interaction = plan_approval 命中", () => {
  assert.equal(
    isPlanApprovalUserInputRequest(
      payload({ schema: { interaction: "plan_approval", toolName: "ExitPlanMode" } }),
    ),
    true,
  );
});

test("schema.toolName = ExitPlanMode 命中（旧快照只有这一路）", () => {
  assert.equal(
    isPlanApprovalUserInputRequest(payload({ schema: { toolName: "ExitPlanMode" } })),
    true,
  );
});

test("普通问答不命中", () => {
  assert.equal(isPlanApprovalUserInputRequest(payload({ toolName: "AskUserQuestion" })), false);
  assert.equal(
    isPlanApprovalUserInputRequest(payload({ schema: { interaction: "ask_user_question" } })),
    false,
  );
});

test("schema 非对象、缺信号时不命中", () => {
  assert.equal(isPlanApprovalUserInputRequest(payload({})), false);
  assert.equal(isPlanApprovalUserInputRequest(payload({ schema: "plan_approval" })), false);
  assert.equal(isPlanApprovalUserInputRequest(payload({ schema: null })), false);
  assert.equal(isPlanApprovalUserInputRequest(payload({ schema: { interaction: "other" } })), false);
});
