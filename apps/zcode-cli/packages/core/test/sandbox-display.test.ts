import assert from "node:assert/strict";
import test from "node:test";
import { SANDBOX_TOOL_NAME, parseToolResultDisplayPayload } from "@zcode/contracts";
import { toolOutputSchema } from "@zcode/shared/zcode-protocol-v4";
import { createToolResultDisplay } from "../src/tool/executor/result-display.js";

// Sandbox 工具的结果卡载荷：只带状态与后台 ID（折叠行的说明文本渲染器从 input 读）。
// 规则见 docs/specs/sandbox-system-tool.md「聊天工具卡」。

function sandboxSuccessOutput(overrides: Record<string, unknown> = {}) {
  return {
    status: "success",
    returnText: "2",
    console: "",
    ...overrides,
  };
}

function assertPersistable(display: NonNullable<ReturnType<typeof createToolResultDisplay>>) {
  const persisted = parseToolResultDisplayPayload(JSON.parse(JSON.stringify(display)));
  assert.deepEqual(persisted, display);

  const protocolOutput = toolOutputSchema.parse({ text: "模型文本投影", display });
  assert.deepEqual(protocolOutput.display, display);
}

test("Sandbox display 成功态只带 status", () => {
  const display = createToolResultDisplay(SANDBOX_TOOL_NAME, sandboxSuccessOutput());

  assert.deepEqual(display, {
    kind: "sandbox",
    status: "success",
  });
  assertPersistable(display!);
});

test("Sandbox display 失败态原样携带 status", () => {
  const display = createToolResultDisplay(
    SANDBOX_TOOL_NAME,
    sandboxSuccessOutput({ status: "failed", error: "语法错" }),
  );

  // 失败走工具抛错时 output 不是 SandboxOutput 形态也可能不生成 display；
  // 这里只断言 status 失败的合法输出形态仍产出载荷。
  assert.deepEqual(display, {
    kind: "sandbox",
    status: "failed",
  });
  assertPersistable(display!);
});

test("Sandbox display 后台态带 backgroundTaskId", () => {
  const display = createToolResultDisplay(
    SANDBOX_TOOL_NAME,
    sandboxSuccessOutput({ status: "backgrounded", backgroundTaskId: "sandbox_abc123" }),
  );

  assert.deepEqual(display, {
    kind: "sandbox",
    status: "backgrounded",
    backgroundTaskId: "sandbox_abc123",
  });
  assertPersistable(display!);
});

test("输出形态不符或无关工具名不生成 display", () => {
  assert.equal(createToolResultDisplay(SANDBOX_TOOL_NAME, { unexpected: true }), undefined);
  assert.equal(createToolResultDisplay("UnrelatedTool", sandboxSuccessOutput()), undefined);
});
