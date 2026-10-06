import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import {
  isPermissionDeniedToolCallRow,
  toolCallRowToLegacyNode,
} from "../src/v4/toolCallRowAdapter.js";

// 计划批准拒绝是预期的搁置终态，不是工具失败：桥接层对历史计划工具行的
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

test("旧拒绝行（无 permissionDenial、input 有计划）同样不判失败", () => {
  // 落盘缺口导致旧行恢复后退化成普通 error：permissionDenial 缺席、
  // error/output 里是拒绝文案，但 input 里计划完好。
  const node = toolCallRowToLegacyNode(
    toolCallRow({
      status: "error",
      input: PLAN_INPUT,
      output: { text: "Permission denied for ExitPlanMode" },
      error: { code: "fault.runtime.toolFailed", message: "Permission denied for ExitPlanMode" },
    }),
  );

  assert.equal(node.toolCall.status, "stopped");
  assert.equal(node.toolCall.error, undefined);
  assert.deepEqual(node.toolCall.input, PLAN_INPUT);
});

test("旧拒绝行判据不认文案：用户反馈文案同样兼容", () => {
  const node = toolCallRowToLegacyNode(
    toolCallRow({
      status: "error",
      input: PLAN_INPUT,
      output: { text: "先补一张时序图再定" },
      error: { code: "fault.runtime.toolFailed", message: "先补一张时序图再定" },
    }),
  );

  assert.equal(node.toolCall.status, "stopped");
  assert.equal(node.toolCall.error, undefined);
});

test("旧拒绝行只有标题也有内容：照样兼容", () => {
  const node = toolCallRowToLegacyNode(
    toolCallRow({
      status: "error",
      input: { title: "缓存验收" },
      output: { text: "Permission denied for ExitPlanMode" },
      error: { code: "fault.runtime.toolFailed", message: "Permission denied for ExitPlanMode" },
    }),
  );

  assert.equal(node.toolCall.status, "stopped");
  assert.equal(node.toolCall.error, undefined);
});

test("计划工具真失败（无 permissionDenial）不受豁免影响", () => {
  // 现场复刻：模型把正文写进 `plan_text`，`plan` 缺失。input 非空（title/overview 齐备），
  // 但这是系统侧入参校验失败（code 为框架的 tool_execution_failed），从未走到权限门，
  // 不能被旧拒绝行兼容抹掉失败标记。
  test("入参校验失败但 input 非空（plan_text 现场形状）仍判失败", () => {
    const node = toolCallRowToLegacyNode(
      toolCallRow({
        status: "error",
        input: {
          title: "缓存验收",
          overview: "收口缓存验收清单，不改代码。",
          plan_text: "# 缓存验收\n正文",
        },
        error: {
          code: "tool_execution_failed",
          message: "Tool input failed inputSchema validation",
        },
      }),
    );

    assert.equal(node.toolCall.status, "failed");
    assert.equal(node.toolCall.error, "Tool input failed inputSchema validation");
    // input 原样透传，不降级。
    assert.deepEqual(node.toolCall.input, {
      title: "缓存验收",
      overview: "收口缓存验收清单，不改代码。",
      plan_text: "# 缓存验收\n正文",
    });
  });

  // 冷恢复同形：code 被改写成 fault.runtime.toolFailed，只能靠 message 里的固定签名识别。
  test("冷恢复形状的校验失败（fault code + 固定签名）仍判失败", () => {
    const node = toolCallRowToLegacyNode(
      toolCallRow({
        status: "error",
        input: {
          title: "缓存验收",
          overview: "收口缓存验收清单，不改代码。",
          plan_text: "# 缓存验收\n正文",
        },
        error: {
          code: "fault.runtime.toolFailed",
          message: "Tool input failed inputSchema validation",
        },
      }),
    );

    assert.equal(node.toolCall.status, "failed");
    assert.equal(node.toolCall.error, "Tool input failed inputSchema validation");
  });

  // 模型侧回传的 InputValidationError 落在 output.text 时同样识别。
  test("output.text 带 InputValidationError 签名时仍判失败", () => {
    const outputText =
      "<tool_use_error>InputValidationError: ExitPlanMode failed due to the following issue:\nThe required parameter `plan` is missing</tool_use_error>";
    const node = toolCallRowToLegacyNode(
      toolCallRow({
        status: "error",
        input: {
          title: "缓存验收",
          overview: "收口缓存验收清单，不改代码。",
          plan_text: "# 缓存验收\n正文",
        },
        output: { text: outputText },
      }),
    );

    assert.equal(node.toolCall.status, "failed");
    assert.ok(typeof node.toolCall.error === "string" && node.toolCall.error.length > 0);
  });
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
