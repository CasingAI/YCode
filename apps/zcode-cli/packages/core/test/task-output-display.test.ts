import assert from "node:assert/strict";
import test from "node:test";
import {
  parseToolResultDisplayPayload,
  TASK_OUTPUT_TOOL_NAME,
} from "@zcode/contracts";
import { toolOutputSchema } from "@zcode/shared/zcode-protocol-v4";
import { createToolResultDisplay } from "../src/tool/executor/result-display.js";

function taskOutputResult(overrides: Record<string, unknown> = {}) {
  return {
    retrieval_status: "success",
    task: {
      task_id: "exec_task-output-display",
      task_type: "local_bash",
      status: "completed",
      description: "运行全仓 TypeScript 类型检查",
      output: "done",
      exitCode: 0,
      ...overrides,
    },
  };
}

test("TaskOutput display 将任务描述投影为可持久化 title", () => {
  const display = createToolResultDisplay(TASK_OUTPUT_TOOL_NAME, taskOutputResult());

  assert.deepEqual(display, {
    kind: "task_output",
    retrievalStatus: "success",
    title: "运行全仓 TypeScript 类型检查",
    taskStatus: "completed",
    output: "done",
  });

  const persisted = parseToolResultDisplayPayload(JSON.parse(JSON.stringify(display)));
  assert.deepEqual(persisted, display);

  const protocolOutput = toolOutputSchema.parse({ text: "done", display });
  assert.deepEqual(protocolOutput.display, display);
});

test("TaskOutput display 对空描述不生成 title", () => {
  const display = createToolResultDisplay(
    TASK_OUTPUT_TOOL_NAME,
    taskOutputResult({ description: "   " }),
  );

  assert.equal(display && "title" in display, false);
});

test("TaskOutput display 有界 title 不影响输出截断语义", () => {
  const display = createToolResultDisplay(
    TASK_OUTPUT_TOOL_NAME,
    taskOutputResult({
      description: "x".repeat(2_049),
      output: "y".repeat(2_001),
    }),
  );

  assert.equal(display && "title" in display && display.title.length, 2_048);
  assert.equal(display && "truncated" in display, true);
});
