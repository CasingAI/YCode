import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { getAgentPrimaryText } from "../src/ToolCallBlocks/renderers/agentHelpers.js";
import { SendMessageToolCallBlock } from "../src/ToolCallBlocks/renderers/send-message.js";
import { TaskOutputToolCallBlock } from "../src/ToolCallBlocks/renderers/task-output.js";
import { TaskStopToolCallBlock } from "../src/ToolCallBlocks/renderers/task-stop.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";
import { buildAgentTitleByIdentity } from "../src/v4/conversationAssistantWorkItems.js";
import type { AssistantWorkRow } from "../src/v4/conversationTurnRenderUnits.js";

const AGENT_ID = "agent_470ab270-ee39-421b-b722-221dc8a31835";
const TITLE = "codeReview · 复核 Description 截断改动";

function renderTaskOutput({
  isRunning = false,
  agentTitleByIdentity,
  display = { kind: "task_output" as const },
}: {
  isRunning?: boolean;
  agentTitleByIdentity?: ReadonlyMap<string, string>;
  display?: {
    kind: "task_output";
    retrievalStatus?: "success" | "not_ready" | "timeout";
    taskStatus?: string;
    output?: string;
    truncated?: boolean;
  };
} = {}): string {
  const context: ToolCallBlockRenderContext = {
    toolCallNode: {
      childToolCalls: [],
      toolCall: {
        toolId: "task-output-render-test",
        toolName: "TaskOutput",
        kind: "TaskOutput",
        title: "TaskOutput",
        input: { task_id: AGENT_ID },
        raw: { display },
        status: isRunning ? "in_progress" : "completed",
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
    isRunning,
    statusLabel: isRunning ? "获取中" : "已完成",
    childToolList: null,
    canToggle: true,
    forceOpen: true,
    agentTitleByIdentity,
  };

  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(TaskOutputToolCallBlock, context),
    ),
  );
}

function renderTool(
  Renderer: (context: ToolCallBlockRenderContext) => ReactNode,
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
  overrides: Partial<ToolCallBlockRenderContext> = {},
): string {
  const context: ToolCallBlockRenderContext = {
    toolCallNode: { childToolCalls: [], toolCall },
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
    ...overrides,
  };
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, { initialLocale: "zh-CN" }, createElement(Renderer, context)),
  );
}

test("TaskOutput 运行态复用子代理标题且不显示内部 ID", () => {
  const markup = renderTaskOutput({
    isRunning: true,
    agentTitleByIdentity: new Map([[AGENT_ID, TITLE]]),
  });

  assert.match(markup, /正在获取任务输出/);
  assert.match(markup, new RegExp(TITLE));
  assert.equal(markup.includes(AGENT_ID), false);
});

test("TaskOutput 没有关联标题时回退到本地化标题", () => {
  const markup = renderTaskOutput();

  assert.match(markup, /任务输出/);
  assert.equal(markup.includes(AGENT_ID), false);
});

test("TaskOutput 映射到内部 ID 时仍回退到本地化标题", () => {
  const markup = renderTaskOutput({
    agentTitleByIdentity: new Map([[AGENT_ID, "agent_internal-id"]]),
  });

  assert.match(markup, /任务输出/);
  assert.equal(markup.includes("agent_internal-id"), false);
});

test("TaskOutput 已完成状态仍显示已获取", () => {
  const markup = renderTaskOutput({
    display: {
      kind: "task_output",
      retrievalStatus: "success",
      taskStatus: "completed",
      output: "done",
    },
  });

  assert.match(markup, /已获取/);
  assert.match(markup, /done/);
});

test("会话标题映射按 Agent 身份隔离并复用 Agent 工具标题", () => {
  const rows = [
    {
      kind: "toolCall",
      rowId: 1,
      turnId: "turn-1",
      toolCallId: "agent-call",
      toolName: "Agent",
      status: "running",
      inputText: "{}",
      input: { description: "复核 Description 截断改动", subagent_type: "codeReview" },
    },
    {
      kind: "subagent",
      rowId: 2,
      turnId: "turn-1",
      entityId: AGENT_ID,
      subagentType: "codeReview",
      status: "running",
      summaryText: "",
      parentToolCallId: "agent-call",
    },
    {
      kind: "toolCall",
      rowId: 3,
      turnId: "turn-1",
      toolCallId: "task-output-call",
      toolName: "TaskOutput",
      status: "running",
      inputText: "{}",
      input: { task_id: AGENT_ID },
    },
    {
      kind: "subagent",
      rowId: 4,
      turnId: "turn-1",
      entityId: "agent_other",
      subagentType: "general-purpose",
      status: "running",
      summaryText: "另一个任务",
      parentToolCallId: "other-agent-call",
    },
    {
      kind: "toolCall",
      rowId: 5,
      turnId: "turn-1",
      toolCallId: "other-task-output-call",
      toolName: "TaskOutput",
      status: "running",
      inputText: "{}",
      input: { task_id: "agent_other" },
    },
  ] as AssistantWorkRow[];

  const titles = buildAgentTitleByIdentity(rows);

  assert.equal(titles.get(AGENT_ID), "复核 Description 截断改动");
  assert.equal(titles.get("agent_other"), "另一个任务");
});

test("SendMessage 使用目标 Agent 标题而不是 to 内部 ID", () => {
  const markup = renderTool(
    SendMessageToolCallBlock,
    {
      toolId: "send-message-render-test",
      toolName: "SendMessage",
      kind: "SendMessage",
      title: "SendMessage",
      input: { to: AGENT_ID, summary: "补充上下文", message: "继续检查" },
      raw: {},
      status: "success",
    },
    { agentTitleByIdentity: new Map([[AGENT_ID, TITLE]]), forceOpen: true, canToggle: true },
  );

  assert.match(markup, new RegExp(TITLE));
  assert.equal(markup.includes(`title="${TITLE}"`), true);
  assert.match(markup, /补充上下文/);
  assert.equal(markup.includes(AGENT_ID), false);
});

test("SendMessage 无关联或目标标题是内部 ID 时显示本地化 fallback", () => {
  const markup = renderTool(
    SendMessageToolCallBlock,
    {
      toolId: "send-message-fallback-test",
      toolName: "SendMessage",
      kind: "SendMessage",
      title: "SendMessage",
      input: { to: AGENT_ID, message: "继续检查" },
      raw: {},
      status: "success",
    },
    {
      forceOpen: true,
      canToggle: true,
      agentTitleByIdentity: new Map([[AGENT_ID, "agent_internal-id"]]),
    },
  );

  assert.match(markup, /目标子智能体/);
  assert.equal(markup.includes(AGENT_ID), false);
});

test("TaskStop 使用任务标题且标准结果不包含 taskId", () => {
  const markup = renderTool(
    TaskStopToolCallBlock,
    {
      toolId: "task-stop-render-test",
      toolName: "TaskStop",
      kind: "TaskStop",
      title: "TaskStop",
      input: { task_id: AGENT_ID },
      output: {
        task_id: AGENT_ID,
        task_type: "local_agent",
        command: "复核 Description 截断改动",
        message: `Successfully stopped task: ${AGENT_ID} (复核 Description 截断改动)`,
      },
      raw: {},
      status: "success",
    },
    { agentTitleByIdentity: new Map([[AGENT_ID, TITLE]]), forceOpen: true, canToggle: true },
  );

  assert.match(markup, new RegExp(TITLE));
  assert.match(markup, /任务已停止/);
  assert.equal(markup.includes(AGENT_ID), false);
});

test("Agent 内部 ID title 回退到 description", () => {
  const toolCall = {
    toolId: "agent-render-test",
    toolName: "Agent",
    kind: "Agent",
    title: AGENT_ID,
    input: { description: "复核 Description 截断改动", subagent_type: "codeReview" },
    raw: {},
    status: "success",
  } as ToolCallBlockRenderContext["toolCallNode"]["toolCall"];

  const title = getAgentPrimaryText(toolCall, "子代理");

  assert.equal(title, "复核 Description 截断改动");
  assert.equal(title.includes(AGENT_ID), false);
});

test("Agent 描述或类型是内部 ID 时继续回退", () => {
  const toolCall = {
    toolId: "agent-internal-description-render-test",
    toolName: "Agent",
    kind: "Agent",
    title: AGENT_ID,
    input: { description: "agent_internal-description", subagent_type: "codeReview" },
    raw: {},
    status: "success",
  } as ToolCallBlockRenderContext["toolCallNode"]["toolCall"];

  const title = getAgentPrimaryText(toolCall, "子代理");

  assert.equal(title, "codeReview");
  assert.equal(title.includes("agent_"), false);
});

test("会话级标题索引可被跨回合工具卡复用", () => {
  const rows = [
    {
      kind: "toolCall",
      rowId: 1,
      turnId: "turn-1",
      toolCallId: "agent-call",
      toolName: "Agent",
      status: "success",
      inputText: "{}",
      input: { description: "跨回合任务" },
    },
    {
      kind: "subagent",
      rowId: 2,
      turnId: "turn-1",
      entityId: AGENT_ID,
      subagentType: "codeReview",
      status: "success",
      summaryText: "",
      parentToolCallId: "agent-call",
    },
    {
      kind: "toolCall",
      rowId: 3,
      turnId: "turn-2",
      toolCallId: "send-message-call",
      toolName: "SendMessage",
      status: "success",
      inputText: "{}",
      input: { to: AGENT_ID },
    },
  ] as AssistantWorkRow[];

  const titles = buildAgentTitleByIdentity(rows);
  assert.equal(titles.get(AGENT_ID), "跨回合任务");
});
