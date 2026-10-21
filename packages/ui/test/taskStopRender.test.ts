import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TaskStopToolCallBlock } from "../src/ToolCallBlocks/renderers/task-stop.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";

const BASH_TASK_ID = "exec_1c2f9a34-7d5e-4a1b-9c88-2f6b0d5e17a4";
const COMMAND = 'cd "C:/Users/MPC/YCodeProject" && npm run build';
const DESCRIPTION = "运行全仓类型检查并打包产物";

function renderTaskStop({
  display,
  output,
  forceOpen = false,
  agentTitleByIdentity,
}: {
  display?: Record<string, unknown>;
  output?: Record<string, unknown>;
  forceOpen?: boolean;
  agentTitleByIdentity?: ReadonlyMap<string, string>;
} = {}): string {
  const context: ToolCallBlockRenderContext = {
    toolCallNode: {
      childToolCalls: [],
      toolCall: {
        toolId: "task-stop-render-test",
        toolName: "TaskStop",
        kind: "TaskStop",
        title: "TaskStop",
        input: { task_id: BASH_TASK_ID },
        output,
        raw: display ? { display } : {},
        status: "completed",
      },
    },
    workspacePath: "/workspace",
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: true,
    },
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: false,
    statusLabel: "",
    childToolList: null,
    canToggle: true,
    forceOpen,
    agentTitleByIdentity,
  };

  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(TaskStopToolCallBlock, context),
    ),
  );
}

test("TaskStop 折叠行显示任务描述而不是命令原文", () => {
  const markup = renderTaskStop({
    display: {
      kind: "task_stop",
      taskId: BASH_TASK_ID,
      taskType: "local_bash",
      command: COMMAND,
      description: DESCRIPTION,
      message: `Successfully stopped task: ${BASH_TASK_ID}`,
    },
  });

  assert.match(markup, new RegExp(DESCRIPTION));
  assert.equal(markup.includes(COMMAND), false);
});

test("TaskStop 折叠行显示描述时不用等宽字体", () => {
  const markup = renderTaskStop({
    display: {
      kind: "task_stop",
      taskId: BASH_TASK_ID,
      taskType: "local_bash",
      command: COMMAND,
      description: DESCRIPTION,
      message: `Successfully stopped task: ${BASH_TASK_ID}`,
    },
  });

  // 描述是给人读的一句话，命令才是代码片段。折叠行只渲染摘要，不渲染展开区。
  assert.equal(markup.includes("font-mono"), false);
});

test("TaskStop 展开区保留命令原文", () => {
  const markup = renderTaskStop({
    forceOpen: true,
    display: {
      kind: "task_stop",
      taskId: BASH_TASK_ID,
      taskType: "local_bash",
      command: COMMAND,
      description: DESCRIPTION,
      message: `Successfully stopped task: ${BASH_TASK_ID}`,
    },
  });

  assert.match(markup, new RegExp("命令"));
  assert.match(markup, new RegExp("npm run build"));
});

test("TaskStop 没有描述时折叠行显示命令原文", () => {
  // 改动前保存的历史卡片没有描述字段，折叠行必须继续显示命令。
  const markup = renderTaskStop({
    display: {
      kind: "task_stop",
      taskId: BASH_TASK_ID,
      taskType: "local_bash",
      command: COMMAND,
      message: `Successfully stopped task: ${BASH_TASK_ID}`,
    },
  });

  assert.match(markup, new RegExp("npm run build"));
});

test("TaskStop 描述与命令同文时按命令显示", () => {
  const markup = renderTaskStop({
    display: {
      kind: "task_stop",
      taskId: BASH_TASK_ID,
      taskType: "local_bash",
      command: COMMAND,
      description: COMMAND,
      message: `Successfully stopped task: ${BASH_TASK_ID}`,
    },
  });

  assert.match(markup, new RegExp("npm run build"));
});

test("TaskStop 关联的 Agent 标题优先于任务描述", () => {
  const agentTitle = "codeReview · 复核截断改动";
  const markup = renderTaskStop({
    display: {
      kind: "task_stop",
      taskId: BASH_TASK_ID,
      taskType: "local_bash",
      command: COMMAND,
      description: DESCRIPTION,
      message: `Successfully stopped task: ${BASH_TASK_ID}`,
    },
    agentTitleByIdentity: new Map([[BASH_TASK_ID, agentTitle]]),
  });

  assert.match(markup, new RegExp(agentTitle));
  assert.equal(markup.includes(DESCRIPTION), false);
});

test("TaskStop 标准成功结果不出现内部任务 ID", () => {
  const markup = renderTaskStop({
    forceOpen: true,
    display: {
      kind: "task_stop",
      taskId: BASH_TASK_ID,
      taskType: "local_bash",
      command: COMMAND,
      description: DESCRIPTION,
      message: `Successfully stopped task: ${BASH_TASK_ID} (${COMMAND})`,
    },
  });

  assert.equal(markup.includes(BASH_TASK_ID), false);
});
