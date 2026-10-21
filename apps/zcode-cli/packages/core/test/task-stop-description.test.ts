import assert from "node:assert/strict";
import test from "node:test";
import { parseToolResultDisplayPayload, TASK_STOP_TOOL_NAME } from "@zcode/contracts";
import { toolOutputSchema } from "@zcode/shared/zcode-protocol-v4";
import { createToolResultDisplay } from "../src/tool/executor/result-display.js";
import { descriptionFromRuntimeTask } from "../src/runtime/methods/background-task-mapping.js";
import { taskStopToolEntry } from "../src/tool/handlers/task-stop.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

const TASK_ID = "exec_task-stop-description";

function taskStopResult(overrides: Record<string, unknown> = {}) {
  return {
    message: `Successfully stopped task: ${TASK_ID} (cd "C:/Users/MPC/YCodeProject")`,
    task_id: TASK_ID,
    task_type: "local_bash",
    command: 'cd "C:/Users/MPC/YCodeProject"',
    ...overrides,
  };
}

function stopContext(
  result: Record<string, unknown>,
): ToolExecutionContext {
  return {
    toolCallId: "task-stop-description-test",
    traceId: "trace-task-stop-description",
    abortSignal: new AbortController().signal,
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
    backgroundTaskControlPort: {
      stopBackgroundTask: async () => result as never,
    },
  } as unknown as ToolExecutionContext;
}

test("TaskStop display 把任务描述投影为可持久化字段", () => {
  const display = createToolResultDisplay(
    TASK_STOP_TOOL_NAME,
    taskStopResult({ description: "运行全仓 TypeScript 类型检查" }),
  );

  assert.deepEqual(display, {
    kind: "task_stop",
    taskId: TASK_ID,
    taskType: "local_bash",
    command: 'cd "C:/Users/MPC/YCodeProject"',
    description: "运行全仓 TypeScript 类型检查",
    message: `Successfully stopped task: ${TASK_ID}`,
  });

  const persisted = parseToolResultDisplayPayload(JSON.parse(JSON.stringify(display)));
  assert.deepEqual(persisted, display);

  const protocolOutput = toolOutputSchema.parse({ text: "done", display });
  assert.deepEqual(protocolOutput.display, display);
});

test("TaskStop display 对空描述不生成 description 字段", () => {
  const display = createToolResultDisplay(TASK_STOP_TOOL_NAME, taskStopResult({ description: "   " }));

  assert.equal(display && "description" in display, false);
});

test("TaskStop display 缺少描述时折叠行退回命令原文", () => {
  const display = createToolResultDisplay(TASK_STOP_TOOL_NAME, taskStopResult());

  assert.equal(display && "description" in display, false);
  assert.equal(display && display.kind === "task_stop" && display.command, 'cd "C:/Users/MPC/YCodeProject"');
});

test("TaskStop 回传描述，让卡片折叠行显示人话而不是命令", async () => {
  const output = await taskStopToolEntry.handler(
    { task_id: TASK_ID },
    stopContext({
      ok: true,
      taskId: TASK_ID,
      type: "local_bash",
      command: 'cd "C:/Users/MPC/YCodeProject"',
      description: "运行全仓 TypeScript 类型检查",
    }),
  );

  assert.deepEqual(output, {
    message: `Successfully stopped task: ${TASK_ID} (cd "C:/Users/MPC/YCodeProject")`,
    task_id: TASK_ID,
    task_type: "local_bash",
    command: 'cd "C:/Users/MPC/YCodeProject"',
    description: "运行全仓 TypeScript 类型检查",
  });
});

test("TaskStop 描述与命令同文时不写描述字段", async () => {
  // runtime 把命令兜底成了描述时，两者是同一串文本。写进去只会让同一句话
  // 占两个位置，卡片按命令展示即可。
  const output = await taskStopToolEntry.handler(
    { task_id: TASK_ID },
    stopContext({
      ok: true,
      taskId: TASK_ID,
      type: "local_bash",
      command: 'cd "C:/Users/MPC/YCodeProject"',
      description: 'cd "C:/Users/MPC/YCodeProject"',
    }),
  );

  assert.equal(
    typeof output === "object" && output !== null && "description" in output,
    false,
  );
});

test("后台任务描述优先取投影条目，其次取 runtime 快照", () => {
  const description = descriptionFromRuntimeTask(
    { description: "runtime 快照里的描述" } as never,
    { description: "投影条目里的描述" } as never,
  );

  assert.equal(description, "投影条目里的描述");
});

test("后台任务描述取不到时为空，不回落成命令", () => {
  const description = descriptionFromRuntimeTask(
    { description: "   " } as never,
    undefined,
  );

  assert.equal(description, undefined);
});
