import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReasoningRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "../src/lib/codePreviewSettings.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ToolCallBlock } from "../src/ToolCallBlocks.js";
import { ExploreToolCallBlock } from "../src/ToolCallBlocks/renderers/explore.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";
import { ConversationRowView } from "../src/v4/ConversationRowView.js";
import type { ConversationRowRenderContext } from "../src/v4/conversationRowContext.js";
import { buildAssistantWorkRenderItems } from "../src/v4/conversationAssistantWorkItems.js";

function todoRow(
  rowId: number,
  toolName: string,
  options: {
    input?: unknown;
    output?: unknown;
    title?: string;
    status?: ToolCallRow["status"];
  } = {},
): ToolCallRow {
  return {
    kind: "toolCall",
    rowId,
    turnId: "turn-1",
    entityId: `tool_${rowId}`,
    createdAt: rowId,
    createdAtSeq: rowId,
    toolCallId: `todo-call-${rowId}`,
    toolName,
    status: options.status ?? "completed",
    inputText: "",
    input: options.input ?? {},
    ...(options.output === undefined ? {} : { output: options.output }),
    ...(options.title === undefined ? {} : { title: options.title }),
  } as ToolCallRow;
}

function genericToolRow(rowId: number, toolName: string, input: unknown): ToolCallRow {
  return {
    kind: "toolCall",
    rowId,
    turnId: "turn-1",
    entityId: `tool_${rowId}`,
    createdAt: rowId,
    createdAtSeq: rowId,
    toolCallId: `call-${rowId}`,
    toolName,
    status: "completed",
    inputText: "",
    input,
  } as ToolCallRow;
}

function reasoningRow(rowId: number): ReasoningRow {
  return {
    kind: "reasoning",
    rowId,
    turnId: "turn-1",
    createdAt: rowId,
    createdAtSeq: rowId,
    text: "thinking",
    state: "complete",
  };
}

function rowContext(): ConversationRowRenderContext {
  return {
    workspacePath: "/workspace",
    theme: "system",
    codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  };
}

function renderRow(row: ToolCallRow): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ConversationRowView, { row, context: rowContext() }),
    ),
  );
}

function renderToolCallBlock(toolCallNode: ToolCallBlockRenderContext["toolCallNode"]): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ToolCallBlock, {
        toolCallNode,
        workspacePath: "/workspace",
        theme: "light",
      }),
    ),
  );
}

function toolCallNode(
  toolId: string,
  toolName: string,
  input: unknown,
  output?: unknown,
): ToolCallBlockRenderContext["toolCallNode"] {
  return {
    childToolCalls: [],
    toolCall: {
      toolId,
      toolName,
      kind: toolName,
      title: toolName,
      input,
      ...(output === undefined ? {} : { output }),
      status: "completed",
    },
  };
}

test("普通工具行入口：context 不含待办显示偏好时 TodoWrite 仍渲染卡片与内容", () => {
  const markup = renderRow(
    todoRow(1, "TodoWrite", {
      input: { todos: [{ content: "整理变更清单", status: "pending" }] },
    }),
  );

  // 旧设置关闭时这里只剩一个空 RowShell；卡片和内容都不应再依赖上下文偏好。
  assert.match(markup, /data-tool-call-id="todo-call-1"/);
  assert.match(markup, /data-tool-name="TodoWrite"/);
  assert.match(markup, /整理变更清单/);
  assert.match(markup, /待办/);
});

test("普通工具行入口：TodoRead 同样渲染卡片与输出里的待办内容", () => {
  const markup = renderRow(
    todoRow(2, "TodoRead", {
      // v4 行的结构化 output 收在 output.text；旧卡片适配层只读这段文本。
      output: {
        text: JSON.stringify({ todos: [{ content: "复核回归场景", status: "completed" }] }),
      },
    }),
  );

  assert.match(markup, /data-tool-call-id="todo-call-2"/);
  assert.match(markup, /data-tool-name="TodoRead"/);
  assert.match(markup, /复核回归场景/);
});

test("运行中的 TodoWrite：待办内容已到达时仍渲染卡片与待办", () => {
  const markup = renderRow(
    todoRow(3, "TodoWrite", {
      status: "running",
      input: { todos: [{ content: "运行中的待办", status: "in_progress" }] },
    }),
  );

  assert.match(markup, /data-tool-call-id="todo-call-3"/);
  assert.match(markup, /data-tool-name="TodoWrite"/);
  assert.match(markup, /运行中的待办/);
  assert.match(markup, /待办/);
});

test("工具卡入口：TodoRead 默认渲染器可见（不传任何显示开关）", () => {
  const markup = renderToolCallBlock(
    toolCallNode(
      "todo-read-block",
      "TodoRead",
      {},
      {
        todos: [{ content: "读取待办输出", status: "in_progress" }],
      },
    ),
  );

  assert.match(markup, /data-tool-name="TodoRead"/);
  assert.match(markup, /读取待办输出/);
});

test("嵌套子工具：Explore 展开内容里的 TodoWrite 仍走同一张卡片", () => {
  const childNode = toolCallNode("nested-todo", "TodoWrite", {
    todos: [{ content: "嵌套子工具待办", status: "pending" }],
  });
  const childToolList = createElement(ToolCallBlock, {
    toolCallNode: childNode,
    workspacePath: "/workspace",
    theme: "light",
    showIcon: false,
    suppressSourceLabel: true,
  });
  const context = {
    toolCallNode: {
      childToolCalls: [childNode],
      toolCall: {
        toolId: "explore-parent",
        toolName: "Glob",
        kind: "Glob",
        title: "Glob",
        input: { pattern: "*" },
        output: "ok",
        status: "completed",
      },
    },
    workspacePath: "/workspace",
    theme: "light",
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
    statusLabel: "已完成",
    childToolList,
    canToggle: true,
    forceOpen: true,
  } as unknown as ToolCallBlockRenderContext;

  const markup = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ExploreToolCallBlock, context),
    ),
  );

  assert.match(markup, /data-tool-name="TodoWrite"/);
  assert.match(markup, /嵌套子工具待办/);
});

test("未知工具不回归：没有待办过滤后仍落到既有 fallback", () => {
  const markup = renderToolCallBlock(toolCallNode("unknown-tool", "MysteryTool", { x: 1 }, "ok"));

  assert.match(markup, /data-tool-name="MysteryTool"/);
  assert.match(markup, /MysteryTool/);
});

test("Todo 保留独立行：两段过程之间可见，且不计入四类过程统计", () => {
  const items = buildAssistantWorkRenderItems([
    genericToolRow(1, "Grep", { pattern: "alpha" }),
    todoRow(2, "TodoWrite", {
      input: { todos: [{ content: "中间的待办", status: "in_progress" }] },
    }),
    genericToolRow(3, "Bash", { command: "pnpm test" }),
    reasoningRow(4),
  ]);

  assert.deepEqual(
    items.map((item) => item.kind),
    ["process", "row", "process"],
  );
  const first = items[0];
  const todoItem = items[1];
  const second = items[2];
  assert.ok(first && first.kind === "process");
  assert.ok(todoItem && todoItem.kind === "row" && todoItem.row.kind === "toolCall");
  assert.equal(todoItem.row.toolName, "TodoWrite");
  assert.ok(second && second.kind === "process");
  assert.deepEqual(first.counts, {
    "file-search": 1,
    "file-find": 0,
    "directory-list": 0,
    "file-read": 0,
    "web-search": 0,
    "web-read": 0,
    terminal: 0,
    changes: 0,
    reasoning: 0,
  });
  assert.deepEqual(second.counts, {
    "file-search": 0,
    "file-find": 0,
    "directory-list": 0,
    "file-read": 0,
    "web-search": 0,
    "web-read": 0,
    terminal: 1,
    changes: 0,
    reasoning: 1,
  });
});

test("渲染链路不再声明或消费待办显示开关", async () => {
  const paths = [
    "../src/ToolCallBlocks.tsx",
    "../src/ToolCallBlocks/fileSummaryTypes.ts",
    "../src/v4/conversationRowContext.ts",
    "../src/v4/ConversationRowView.tsx",
    "../src/v4/ConversationTurnGroup.tsx",
    "../src/v4/ConversationAgentToolCallRow.tsx",
    "../src/v4/SessionPane.tsx",
  ];
  const sources = await Promise.all(
    paths.map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );

  for (const source of sources) {
    assert.doesNotMatch(source, /showTodoToolCalls/);
    assert.doesNotMatch(source, /messageStreamShowTodos/);
  }
});
