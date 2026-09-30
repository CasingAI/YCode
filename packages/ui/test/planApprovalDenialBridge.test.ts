import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import {
  isPermissionDeniedToolCallRow,
  toolCallRowToLegacyNode,
} from "../src/v4/toolCallRowAdapter.js";

// 计划批准拒绝是预期的搁置终态，不是工具失败：桥接层对 ExitPlanMode 的
// permissionDenial 豁免失败标记，行自然渲染成计划卡。豁免只认“计划批准工具 +
// 拒绝在场”，不用 reason 文案（文案易碎）。

const PLAN_INPUT = {
  title: "缓存验收",
  overview: "收口缓存验收清单，不改代码。",
  plan: "# 缓存验收\n正文",
};

function toolCallRow(overrides: Partial<ToolCallRow>): ToolCallRow {
  return {
    rowId: 1,
    kind: "toolCall",
    createdAt: 1_700_000_000_000,
    turnId: "turn-1",
    toolCallId: "call-1",
    toolName: "ExitPlanMode",
    status: "cancelled",
    inputText: "",
    ...overrides,
  } as ToolCallRow;
}

test("计划批准拒绝不判失败：status 回落 wire 映射，error 为空", () => {
  const node = toolCallRowToLegacyNode(
    toolCallRow({
      input: PLAN_INPUT,
      permissionDenial: { decision: "deny", reason: "Permission denied for ExitPlanMode" },
    }),
  );

  // wire cancelled → legacy stopped，天然非失败；error 为空，渲染器失败分支到不了。
  assert.equal(node.toolCall.status, "stopped");
  assert.equal(node.toolCall.error, undefined);
  // input 完好透传，计划卡有内容可渲染。
  assert.deepEqual(node.toolCall.input, PLAN_INPUT);
  // reason 留在 raw 里可查，只是 no longer 以 error 身份进入失败语义。
  assert.deepEqual(node.toolCall.raw?.permissionDenial, {
    decision: "deny",
    reason: "Permission denied for ExitPlanMode",
  });
});

test("计划批准拒绝不再被识别为拒绝行", () => {
  assert.equal(
    isPermissionDeniedToolCallRow(
      toolCallRow({
        permissionDenial: { decision: "deny", reason: "Permission denied for ExitPlanMode" },
      }),
    ),
    false,
  );
});

test("豁免只认工具名：普通工具的拒绝仍判 denied", () => {
  const node = toolCallRowToLegacyNode(
    toolCallRow({
      toolName: "Bash",
      input: { command: "rm -rf /" },
      permissionDenial: { decision: "deny", reason: "Ask mode blocked this tool" },
    }),
  );

  assert.equal(node.toolCall.status, "denied");
  assert.equal(node.toolCall.error, "Ask mode blocked this tool");
  assert.equal(
    isPermissionDeniedToolCallRow(
      toolCallRow({
        toolName: "Bash",
        permissionDenial: { decision: "deny", reason: "Ask mode blocked this tool" },
      }),
    ),
    true,
  );
});

test("工具名大小写/空白口径与判定实现一致", () => {
  const node = toolCallRowToLegacyNode(
    toolCallRow({
      toolName: "  exitplanmode  ",
      input: PLAN_INPUT,
      permissionDenial: { decision: "deny", reason: "Permission denied for ExitPlanMode" },
    }),
  );

  assert.equal(node.toolCall.status, "stopped");
  assert.equal(node.toolCall.error, undefined);
});

test("ExitPlanMode 真失败（无 permissionDenial）不受豁免影响", () => {
  const node = toolCallRowToLegacyNode(
    toolCallRow({
      status: "error",
      input: {},
      output: { text: "Tool input failed inputSchema validation" },
    }),
  );

  assert.equal(node.toolCall.status, "failed");
  assert.equal(node.toolCall.error, "Tool input failed inputSchema validation");
});
