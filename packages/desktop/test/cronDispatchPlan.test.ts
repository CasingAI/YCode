// 到点必达派发决策（docs/specs/automation-dispatch-session-trace.md）：
// - 解析成功 → session-scope（现状流程）；
// - 解析失败 + 有保存的具体选择 → execution-passthrough（会话必建、消息必达，不回落首选）；
// - 组意图 / 无首选场景没有可绑定模型 → dispatch-reject（维持派发失败重试现状）。
import assert from "node:assert/strict";
import test from "node:test";
import { resolveCronDispatchPlan } from "../src/host/cronDispatchPlan.js";

const savedSelection = {
  providerId: "cliproxy-codex-2",
  modelId: "codex-6c3b1ab0/gpt-6-astra",
  options: { reasoningLevel: "xhigh" },
} as const;

const resolvedSelection = {
  providerId: "account:bigmodel-start-plan",
  modelId: "GLM-5.3-Flash",
  options: { reasoningLevel: "high" },
} as const;

test("解析成功走会话域现状流程", () => {
  const plan = resolveCronDispatchPlan({
    resolutionOk: true,
    resolvedSelection: resolvedSelection,
  });
  assert.equal(plan.kind, "session-scope");
  assert.equal(plan.kind === "session-scope" && plan.selection === resolvedSelection, true);
});

test("解析失败但有保存的具体选择时直发执行域", () => {
  const plan = resolveCronDispatchPlan({
    resolutionOk: false,
    resolutionErrorMessage: "Automation 模型选择不可用，请重新选择模型与思考档位",
    passthroughSelection: savedSelection,
  });
  assert.equal(plan.kind, "execution-passthrough");
  assert.deepEqual(plan.kind === "execution-passthrough" && plan.selection, savedSelection);
  assert.equal(
    plan.kind === "execution-passthrough" && plan.resolutionError.includes("模型选择不可用"),
    true,
  );
});

test("组意图与无首选场景维持派发失败现状", () => {
  const reject = resolveCronDispatchPlan({
    resolutionOk: false,
    resolutionErrorMessage: "模型组「team」已删除，请另选模型 [reason=modelGroup.deleted]",
  });
  assert.equal(reject.kind, "dispatch-reject");

  const noPreferred = resolveCronDispatchPlan({
    resolutionOk: false,
    resolutionErrorMessage: "Automation 无法从目标 Host 解析首选模型",
  });
  assert.equal(noPreferred.kind, "dispatch-reject");
});

test("解析成功时忽略 passthrough 候选", () => {
  const plan = resolveCronDispatchPlan({
    resolutionOk: true,
    resolvedSelection: resolvedSelection,
    passthroughSelection: savedSelection,
  });
  assert.equal(plan.kind, "session-scope");
});
