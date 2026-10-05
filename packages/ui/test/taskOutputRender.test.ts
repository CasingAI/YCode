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
import {
  buildAgentTitleByIdentity,
  buildWorkTitleByIdentity,
} from "../src/v4/conversationAssistantWorkItems.js";
import type { AssistantWorkRow } from "../src/v4/conversationTurnRenderUnits.js";

const AGENT_ID = "agent_470ab270-ee39-421b-b722-221dc8a31835";
const TITLE = "codeReview · 复核 Description 截断改动";

function renderTaskOutput({
  isRunning = false,
  agentTitleByIdentity,
  workTitleByIdentity,
  input = { task_id: AGENT_ID },
  startedAt,
  durationMs,
  isOfficeMode = false,
  onOpenBackgroundBash,
  display = { kind: "task_output" as const },
}: {
  isRunning?: boolean;
  agentTitleByIdentity?: ReadonlyMap<string, string>;
  workTitleByIdentity?: ReadonlyMap<string, string>;
  input?: unknown;
  startedAt?: number;
  durationMs?: number;
  isOfficeMode?: boolean;
  onOpenBackgroundBash?: ToolCallBlockRenderContext["onOpenBackgroundBash"];
  display?: {
    kind: "task_output";
    retrievalStatus?: "success" | "not_ready" | "timeout";
    title?: string;
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
        input,
        raw: { display },
        status: isRunning ? "in_progress" : "completed",
        startedAt,
        durationMs,
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
    workTitleByIdentity,
    isOfficeMode,
    onOpenBackgroundBash,
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

  assert.match(markup, /获取输出/);
  assert.match(markup, new RegExp(TITLE));
  assert.equal(markup.includes(AGENT_ID), false);
});

test("TaskOutput 没有关联标题时回退到本地化标题", () => {
  const markup = renderTaskOutput();

  assert.match(markup, /任务输出/);
  assert.equal(markup.includes(AGENT_ID), false);
});

test("TaskOutput 等待期用后台任务描述当标题而不是通用任务输出", () => {
  // display.title 来自工具结果，等待期间还没有结果；workTitleByIdentity 用派生该任务的
  // 工具行上的 description 顶上，避免卡片只显示「任务输出」。
  const description = "后台运行一个每秒输出、持续约 5 分钟的任务";
  const markup = renderTaskOutput({
    isRunning: true,
    workTitleByIdentity: new Map([[AGENT_ID, description]]),
  });

  assert.match(markup, new RegExp(description));
  assert.equal(markup.includes(AGENT_ID), false);
});

test("TaskOutput 等待期命中的是 Bash 任务的 workId", () => {
  const workId = "exec_0c9645a7-73be-4b27-9d1a-082e518e1899";
  const description = "每秒打印一行心跳";
  const markup = renderTaskOutput({
    isRunning: true,
    input: { task_id: workId, block: true, timeout: 60_000 },
    startedAt: Date.now(),
    workTitleByIdentity: new Map([[workId, description]]),
  });

  assert.match(markup, new RegExp(description));
  assert.equal(markup.includes(workId), false);
});

test("TaskOutput 结果标题优先于等待期的工作描述", () => {
  const workDescription = "工具行上的旧描述";
  const resultTitle = "runtime 投影的权威描述";
  const markup = renderTaskOutput({
    workTitleByIdentity: new Map([[AGENT_ID, workDescription]]),
    display: { kind: "task_output", retrievalStatus: "success", title: resultTitle },
  });

  assert.match(markup, new RegExp(resultTitle));
  assert.equal(markup.includes(workDescription), false);
});

test("TaskOutput Agent 标题优先于等待期的工作描述", () => {
  const markup = renderTaskOutput({
    isRunning: true,
    agentTitleByIdentity: new Map([[AGENT_ID, TITLE]]),
    workTitleByIdentity: new Map([[AGENT_ID, "工具行上的旧描述"]]),
  });

  assert.match(markup, new RegExp(TITLE));
  assert.equal(markup.includes("工具行上的旧描述"), false);
});

test("TaskOutput 工作描述是内部 ID 时仍回退到本地化标题", () => {
  const markup = renderTaskOutput({
    isRunning: true,
    workTitleByIdentity: new Map([[AGENT_ID, AGENT_ID]]),
  });

  assert.match(markup, /任务输出/);
  assert.equal(markup.includes(AGENT_ID), false);
});

test("TaskOutput 读不到 task_id 时不查工作描述索引", () => {
  const markup = renderTaskOutput({
    isRunning: true,
    input: { block: true, timeout: 15_000 },
    startedAt: Date.now(),
    workTitleByIdentity: new Map([[AGENT_ID, "不该被用上的描述"]]),
  });

  assert.match(markup, /任务输出/);
  assert.equal(markup.includes("不该被用上的描述"), false);
});

test("TaskOutput 运行中显示本次等待预算的倒计时", () => {
  const markup = renderTaskOutput({
    isRunning: true,
    input: { task_id: AGENT_ID, block: true, timeout: 15_000 },
    startedAt: Date.now(),
  });

  assert.match(markup, /还剩 15 秒/);
});

test("TaskOutput 倒计时按起点递减而不是恒显满预算", () => {
  const markup = renderTaskOutput({
    isRunning: true,
    input: { task_id: AGENT_ID, block: true, timeout: 15_000 },
    startedAt: Date.now() - 3_000,
  });

  // 少 1 秒就是 14，正是复用「最小 1 秒」钳位的耗时会算错的那个数。
  assert.match(markup, /还剩 12 秒/);
});

test("TaskOutput 倒计时预算耗尽后停在 0 而不是负数", () => {
  const markup = renderTaskOutput({
    isRunning: true,
    input: { task_id: AGENT_ID, block: true, timeout: 15_000 },
    startedAt: Date.now() - 40_000,
  });

  assert.match(markup, /还剩 0 秒/);
  // 不能出现负数秒数。SVG 的 path 数据里本来就有连字符，所以只查秒数前那一处。
  assert.equal(/还剩 -\d/.test(markup), false);
});

test("TaskOutput block=false 时不显示等待文案", () => {
  const markup = renderTaskOutput({
    isRunning: true,
    input: { task_id: AGENT_ID, block: false, timeout: 15_000 },
    startedAt: Date.now(),
  });

  assert.equal(markup.includes("还剩"), false);
});

test("TaskOutput 读不到等待预算时不显示等待文案", () => {
  // 参数仍在流式解析：input 还是半截或缺 timeout。此时不显示，而不是回落到契约默认值
  // 显示一个并非本次真实调用的预算。
  const missingTimeout = renderTaskOutput({
    isRunning: true,
    input: { task_id: AGENT_ID, block: true },
    startedAt: Date.now(),
  });
  const missingInput = renderTaskOutput({
    isRunning: true,
    input: undefined,
    startedAt: Date.now(),
  });

  assert.equal(missingTimeout.includes("还剩"), false);
  assert.equal(missingInput.includes("还剩"), false);
  assert.equal(missingInput.includes("NaN"), false);
  assert.equal(missingInput.includes("undefined"), false);
});

test("TaskOutput Office mode 不显示等待文案", () => {
  const markup = renderTaskOutput({
    isRunning: true,
    isOfficeMode: true,
    input: { task_id: AGENT_ID, block: true, timeout: 15_000 },
    startedAt: Date.now(),
  });

  assert.equal(markup.includes("还剩"), false);
});

test("TaskOutput 超时终态只显示状态词不显示时长", () => {
  // durationMs 的口径是 ToolCallResult 事件减 ToolCallStarted，把读输出文件与结果序列化
  // 都算进去了。拿它当「等了多久」会把 2 分钟预算显示成「已等待 2 分 1 秒」。
  const markup = renderTaskOutput({
    input: { task_id: AGENT_ID, block: true, timeout: 15_000 },
    startedAt: Date.now() - 15_000,
    durationMs: 15_000,
    display: { kind: "task_output", retrievalStatus: "timeout", taskStatus: "running" },
  });

  assert.match(markup, /等待超时/);
  assert.equal(markup.includes("还剩"), false);
  assert.equal(/已等待|耗时|持续/.test(markup), false);
  assert.equal(markup.includes("NaN"), false);
});

test("TaskOutput 超时终态即便 durationMs 超预算也不显示漂移后的时长", () => {
  const markup = renderTaskOutput({
    input: { task_id: AGENT_ID, block: true, timeout: 120_000 },
    startedAt: Date.now() - 121_000,
    // 真实场景：轮询 100ms 步长 + 读输出文件，会比预算多几十毫秒。
    durationMs: 120_050,
    display: { kind: "task_output", retrievalStatus: "timeout", taskStatus: "running" },
  });

  assert.match(markup, /等待超时/);
  assert.equal(markup.includes("2 分 1 秒"), false);
});

test("TaskOutput 预算超过一分钟时按分秒拆分", () => {
  const markup = renderTaskOutput({
    isRunning: true,
    input: { task_id: AGENT_ID, block: true, timeout: 300_000 },
    startedAt: Date.now() - 215_000,
  });

  assert.match(markup, /还剩 1 分 25 秒/);
});

test("TaskOutput 已成功读取时不再显示等待文案", () => {
  const markup = renderTaskOutput({
    input: { task_id: AGENT_ID, block: true, timeout: 15_000 },
    startedAt: Date.now() - 2_000,
    durationMs: 2_000,
    display: { kind: "task_output", retrievalStatus: "success", taskStatus: "completed" },
  });

  assert.match(markup, /已获取/);
  assert.equal(markup.includes("还剩"), false);
});

const BASH_TASK_ID = "exec_1c2f9a34-7d5e-4a1b-9c88-2f6b0d5e17a4";

test("TaskOutput 对 Bash 后台任务渲染输出面板跳转入口", () => {
  const markup = renderTaskOutput({
    input: { task_id: BASH_TASK_ID, block: true, timeout: 15_000 },
    display: {
      kind: "task_output",
      retrievalStatus: "success",
      taskStatus: "completed",
      title: "运行全仓类型检查",
      output: "done",
    },
    onOpenBackgroundBash: () => {},
  });

  assert.match(markup, /在输出面板中查看/);
  assert.match(markup, /data-testid="task-output-open-preview"/);
});

test("TaskOutput 对子代理任务不渲染跳转入口", () => {
  // agent_ 是子代理任务而非 Bash 后台任务，侧面板查询端必然返回 unavailable。
  const markup = renderTaskOutput({
    input: { task_id: AGENT_ID, block: true, timeout: 15_000 },
    display: {
      kind: "task_output",
      retrievalStatus: "success",
      taskStatus: "completed",
      output: "ok",
    },
    onOpenBackgroundBash: () => {},
  });

  assert.equal(markup.includes("在输出面板中查看"), false);
  assert.equal(markup.includes("task-output-open-preview"), false);
});

test("TaskOutput 宿主未注入跳转回调时不渲染入口", () => {
  const markup = renderTaskOutput({
    input: { task_id: BASH_TASK_ID, block: true, timeout: 15_000 },
    display: {
      kind: "task_output",
      retrievalStatus: "success",
      taskStatus: "completed",
      output: "done",
    },
  });

  assert.equal(markup.includes("task-output-open-preview"), false);
});

test("TaskOutput 读不到 task_id 时不渲染跳转入口", () => {
  const markup = renderTaskOutput({
    input: { block: true, timeout: 15_000 },
    display: {
      kind: "task_output",
      retrievalStatus: "success",
      taskStatus: "completed",
      output: "done",
    },
    onOpenBackgroundBash: () => {},
  });

  assert.equal(markup.includes("task-output-open-preview"), false);
});

test("TaskOutput 无 Agent 关联时显示任务描述", () => {
  const description = "运行全仓 TypeScript 类型检查";
  const markup = renderTaskOutput({
    display: {
      kind: "task_output",
      retrievalStatus: "success",
      title: description,
    },
  });

  assert.match(markup, new RegExp(description));
});

test("TaskOutput 关联 Agent 标题优先于任务描述", () => {
  const description = "运行全仓 TypeScript 类型检查";
  const markup = renderTaskOutput({
    agentTitleByIdentity: new Map([[AGENT_ID, TITLE]]),
    display: {
      kind: "task_output",
      retrievalStatus: "success",
      title: description,
    },
  });

  assert.match(markup, new RegExp(TITLE));
  assert.equal(markup.includes(description), false);
});

test("TaskOutput 任务描述是内部 ID 时回退到本地化标题", () => {
  const internalTitle = "exec_internal-task";
  const markup = renderTaskOutput({
    display: {
      kind: "task_output",
      retrievalStatus: "success",
      title: internalTitle,
    },
  });

  assert.match(markup, /任务输出/);
  assert.equal(markup.includes(internalTitle), false);
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

test("后台任务描述索引按 workId 关联 Bash 工具行", () => {
  const workId = "exec_0c9645a7-73be-4b27-9d1a-082e518e1899";
  const rows = [
    {
      kind: "toolCall",
      rowId: 1,
      turnId: "turn-1",
      toolCallId: "bash-call",
      toolName: "Bash",
      status: "running",
      inputText: "{}",
      input: {
        description: "每秒打印一行心跳",
        command: "while true; do echo tick; sleep 1; done",
      },
      backgrounded: true,
      workId,
    },
  ] as AssistantWorkRow[];

  const titles = buildWorkTitleByIdentity(rows);

  // 刻意不回落 command：那会把一整条命令铺到卡片标题上。
  assert.equal(titles.get(workId), "每秒打印一行心跳");
});

test("后台任务描述索引跳过没有 workId 或没有 description 的行", () => {
  const rows = [
    {
      kind: "toolCall",
      rowId: 1,
      turnId: "turn-1",
      toolCallId: "plain-bash",
      toolName: "Bash",
      status: "success",
      inputText: "{}",
      input: { description: "没有 workId 的前台命令" },
    },
    {
      kind: "toolCall",
      rowId: 2,
      turnId: "turn-1",
      toolCallId: "bash-no-description",
      toolName: "Bash",
      status: "running",
      inputText: "{}",
      input: { command: "sleep 60" },
      backgrounded: true,
      workId: "exec_no_description",
    },
    {
      kind: "turnHeader",
      rowId: 3,
      turnId: "turn-1",
    },
  ] as AssistantWorkRow[];

  const titles = buildWorkTitleByIdentity(rows);

  assert.equal(titles.size, 0);
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
