import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ReadToolCallBlock, buildReadSummary } from "../src/ToolCallBlocks/renderers/read.js";
import {
  SearchToolCallBlock,
  getSearchPrimaryText,
} from "../src/ToolCallBlocks/renderers/search.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";
import {
  classifyToolCallActivity,
  getToolCallActivityTarget,
  isToolCallActivityRunning,
} from "../src/lib/toolCallActivity.js";
import { ConversationShareReadonlyTimeline } from "../src/v4/ConversationShareReadonlyTimeline.js";
import { buildAssistantWorkRenderItems } from "../src/v4/conversationAssistantWorkItems.js";

function toolRenderContext(options: {
  toolName: string;
  input: unknown;
  kind?: string;
  title?: string;
  raw?: unknown;
  output?: unknown;
  status?: string;
  statusLabel?: string;
  isRunning?: boolean;
  permissionDenial?: ToolCallRow["permissionDenial"];
}): ToolCallBlockRenderContext {
  const failed = options.status === "failed";
  const denied = options.status === "denied";
  return {
    toolCallNode: {
      childToolCalls: [],
      toolCall: {
        toolId: `render-${options.toolName}`,
        toolName: options.toolName,
        kind: options.kind ?? options.toolName,
        title: options.title ?? options.toolName,
        input: options.input,
        raw: options.raw,
        output: options.output,
        status: options.status ?? "completed",
        permissionDenial: options.permissionDenial,
        error: failed || denied ? "Request was not completed" : undefined,
      },
    },
    workspacePath: "/remote/workspace",
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: false,
    },
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: options.isRunning ?? false,
    statusLabel:
      options.statusLabel ??
      (failed ? "执行失败" : denied ? "已拒绝" : options.isRunning ? "运行中" : "已完成"),
    errorText: failed || denied ? "Request was not completed" : undefined,
    childToolList: null,
    canToggle: false,
    forceOpen: false,
  };
}

function renderTool(
  component: (context: ToolCallBlockRenderContext) => React.ReactNode,
  context: ToolCallBlockRenderContext,
  locale: "zh-CN" | "en-US" = "zh-CN",
) {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, { initialLocale: locale }, createElement(component, context)),
  );
}

function shareToolRow(options: {
  rowId: number;
  toolName: string;
  input: unknown;
  status: ToolCallRow["status"];
  output?: ToolCallRow["output"];
  permissionDenial?: ToolCallRow["permissionDenial"];
}): ToolCallRow {
  return {
    kind: "toolCall",
    assistantResponseId: "response-1",
    rowId: options.rowId,
    turnId: "turn-1",
    createdAt: options.rowId,
    createdAtSeq: options.rowId,
    toolCallId: `share-call-${options.rowId}`,
    toolName: options.toolName,
    status: options.status,
    title: options.toolName,
    inputText: JSON.stringify(options.input),
    input: options.input,
    ...(options.output ? { output: options.output } : {}),
    ...(options.permissionDenial ? { permissionDenial: options.permissionDenial } : {}),
    ...(options.status === "error"
      ? { error: { code: "test_error", message: "Request failed" } }
      : {}),
  };
}

function renderShare(toolRows: ToolCallRow[]) {
  const rows: ConversationRow[] = [
    {
      kind: "userInput",
      rowId: 0,
      turnId: "turn-1",
      createdAt: 0,
      createdAtSeq: 0,
      text: "Review these tool results",
      origin: "realUser",
      attachments: [],
    },
    {
      kind: "turnHeader",
      rowId: 1,
      turnId: "turn-1",
      createdAt: 0,
      createdAtSeq: 0,
      origin: "userInput",
      executionKind: "agent",
      state: "completedSuccess",
      startedAt: 0,
      endedAt: 1,
      activeMs: 1_000,
    },
    ...toolRows,
  ];
  return renderToStaticMarkup(createElement(ConversationShareReadonlyTimeline, { rows }));
}

test("Read metadata 分类：输出目录类型可与 input 路径合并", () => {
  const input = { file_path: "/remote/workspace/src" };
  const samples = [
    { raw: { rawOutput: "<type>directory</type>" } },
    {
      raw: {
        rawInput: { file_path: "/remote/workspace/src" },
        rawOutput: { content: "<type>directory</type>" },
      },
    },
    { raw: { content: [{ type: "text", text: "<type>directory</type>" }] } },
  ];

  for (const { raw } of samples) {
    assert.equal(classifyToolCallActivity({ toolName: "Read", input, raw }), "directory-list");
    const markup = renderTool(
      ReadToolCallBlock,
      toolRenderContext({ toolName: "Read", input, raw, status: "completed" }),
    );
    assert.ok(markup.includes("列出目录"));
    assert.ok(markup.includes("src"));
    assert.ok(!markup.includes("读取文件"));
  }
});

test("Read rawOutput 仅含目录标签但没有路径时仍分类为目录", () => {
  const raw = { rawOutput: "<type>directory</type>" };
  assert.equal(
    classifyToolCallActivity({ toolName: "Read", input: { file_path: "/workspace/src" }, raw }),
    "directory-list",
  );
  assert.equal(classifyToolCallActivity({ toolName: "Read", raw }), "directory-list");
});

test("Explore 计数与普通 Read renderer 共用同一分类", () => {
  const raw = { rawOutput: "<type>directory</type>" };
  const input = { file_path: "/remote/workspace/src" };
  const row = {
    kind: "toolCall",
    rowId: 1,
    turnId: "turn-1",
    createdAt: 1,
    createdAtSeq: 1,
    toolCallId: "read-directory",
    toolName: "Read",
    status: "success",
    title: "Read",
    inputText: "",
    input,
    output: { text: "<type>directory</type>" },
  } satisfies ToolCallRow;
  assert.equal(classifyToolCallActivity(row), "directory-list");
  const secondRow = {
    ...row,
    rowId: 2,
    toolCallId: "read-b",
  };
  const groupRows = [row, secondRow];
  // 连续两次目录读取现在是两条独立 row，不再合成 Explore 容器。
  const items = buildAssistantWorkRenderItems(groupRows, { enableProcess: false });
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.kind === "row"));
  const renderedRows = items.map((item) => {
    assert.ok(item.kind === "row");
    assert.ok(item.row.kind === "toolCall");
    return item.row;
  });
  assert.deepEqual(
    renderedRows.map((rendered) => rendered.rowId),
    [1, 2],
  );
  assert.deepEqual(
    renderedRows.map((rendered) => rendered.toolName),
    ["Read", "Read"],
  );
  for (const rendered of renderedRows) {
    assert.equal(classifyToolCallActivity(rendered), "directory-list");
  }
  const process = buildAssistantWorkRenderItems(groupRows).find((item) => item.kind === "process");
  assert.ok(process && process.kind === "process");
  assert.equal(process.counts["directory-list"], 2);
  assert.equal(process.counts["file-read"], 0);
  const markup = renderTool(ReadToolCallBlock, toolRenderContext({ toolName: "Read", input, raw }));
  assert.ok(markup.includes("列出目录"));
  assert.ok(!markup.includes("读取文件"));
});

test("Read parsed_cmd 保留工作目录并正确拼接跨平台路径", () => {
  for (const [cwd, relativePath, expected] of [
    ["/remote/workspace", "src/app.ts", "/remote/workspace/src/app.ts"],
    ["C:\\workspace", "src\\app.ts", "C:\\workspace\\src\\app.ts"],
    ["/remote/workspace", "/external/app.ts", "/external/app.ts"],
  ]) {
    const context = toolRenderContext({
      toolName: "Read",
      input: { cwd, parsed_cmd: [{ type: "read", path: relativePath }] },
    });
    assert.equal(buildReadSummary(context.toolCallNode.toolCall)?.path, expected);
    assert.equal(getToolCallActivityTarget(context.toolCallNode.toolCall), expected);
  }
});

test("活动运行态只认实际执行，不把等待或终态当执行中", () => {
  for (const status of ["in_progress", "running"]) {
    assert.equal(isToolCallActivityRunning({ status }), true);
  }
  for (const status of [
    "pending",
    "inputStreaming",
    "pendingApproval",
    "queued",
    "success",
    "completed",
    "failed",
    "error",
    "denied",
    "stopped",
    "cancelled",
  ]) {
    assert.equal(isToolCallActivityRunning({ status, raw: { v4Status: "running" } }), false);
  }
  assert.equal(isToolCallActivityRunning({ raw: { v4Status: "running" } }), true);
});

test("文件和网页交替时不再切组，逐条保留原始顺序与活动分类", () => {
  const names = ["Grep", "Read", "WebSearch", "WebFetch", "Glob", "Read"];
  const rows = names.map((toolName, index) =>
    shareToolRow({
      rowId: index + 1,
      toolName,
      input: {},
      status: "success",
    }),
  );
  const items = buildAssistantWorkRenderItems(rows, { enableProcess: false });
  // 不再按「文件组 / 网页组」切分，所有工具行按原始行序逐条铺开。
  assert.equal(items.length, names.length);
  assert.ok(items.every((item) => item.kind === "row"));
  const renderedRows = items.map((item) => {
    assert.ok(item.kind === "row");
    assert.ok(item.row.kind === "toolCall");
    return item.row;
  });
  assert.deepEqual(
    renderedRows.map((rendered) => rendered.rowId),
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    renderedRows.map((rendered) => rendered.toolName),
    names,
  );
  // 活动分类顺序仍是 Grep → Read → WebSearch → WebFetch → Glob → Read，不重排。
  assert.deepEqual(
    renderedRows.map((rendered) => classifyToolCallActivity(rendered)),
    ["file-search", "file-read", "web-search", "web-read", "file-find", "file-read"],
  );
});

test("连续查阅工具不再聚合成 Explore 容器，过程计数仍按细分活动统计", () => {
  const names = ["Read", "Read", "Read", "WebSearch", "WebFetch"];
  const rows = names.map((toolName, index) =>
    shareToolRow({
      rowId: index + 1,
      toolName,
      input: {},
      status: "success",
    }),
  );

  // 关闭过程折叠：每条工具行都是独立 row，数量与输入一致且顺序不变。
  const items = buildAssistantWorkRenderItems(rows, { enableProcess: false });
  assert.equal(items.length, rows.length);
  assert.ok(items.every((item) => item.kind === "row"));
  const renderedRows = items.map((item) => {
    assert.ok(item.kind === "row");
    assert.ok(item.row.kind === "toolCall");
    return item.row;
  });
  assert.deepEqual(
    renderedRows.map((rendered) => rendered.rowId),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    renderedRows.map((rendered) => rendered.toolName),
    names,
  );

  // 打开过程折叠：仍是一条过程行，但细分为 3 次文件读取 / 1 次网页搜索 / 1 次网页读取。
  const process = buildAssistantWorkRenderItems(rows).find((item) => item.kind === "process");
  assert.ok(process && process.kind === "process");
  assert.equal(process.counts["file-read"], 3);
  assert.equal(process.counts["web-search"], 1);
  assert.equal(process.counts["web-read"], 1);
  assert.equal(process.nodes.length, rows.length);
  assert.ok(process.nodes.every((node) => node.kind === "row"));
});

test("只读分享与普通行一致识别输出目录类型并保留路径", () => {
  const markup = renderShare([
    shareToolRow({
      rowId: 2,
      toolName: "Read",
      input: { file_path: "/remote/workspace/src" },
      output: { text: "<type>directory</type>" },
      status: "success",
    }),
  ]);
  assert.ok(markup.includes("列出目录"));
  assert.ok(markup.includes("/remote/workspace/src"));
  assert.ok(!markup.includes("读取文件"));
});

test("普通 Search 卡：WebFetch 同时有 prompt 与 URL 时优先显示 URL", () => {
  const markup = renderTool(
    SearchToolCallBlock,
    toolRenderContext({
      toolName: "WebFetch",
      input: { prompt: "summarize this page", url: "https://example.com/article" },
    }),
  );
  assert.ok(markup.includes("https://example.com/article"));
  assert.ok(!markup.includes("summarize this page"));
});

test("未知工具即使 input 含 URL 也不猜网页类别", () => {
  const classify = classifyToolCallActivity({
    toolName: "LegacyUnknown",
    input: { url: "https://example.com" },
  });
  assert.equal(classify, "unknown");
  assert.equal(
    getSearchPrimaryText(
      { formatMessage: ({ id }) => id },
      { url: "https://example.com" },
      { toolName: "LegacyUnknown", title: "Historical tool" },
    ),
    "https://example.com",
  );
});

test("Search 缺少目标时不重复动作文案", () => {
  const markup = renderTool(
    SearchToolCallBlock,
    toolRenderContext({ toolName: "WebSearch", input: {} }),
  );
  assert.equal((markup.match(/搜索网页/g) ?? []).length, 1);
});

test("分享只读渲染：Read file_path 目标显示在摘要中", () => {
  const markup = renderShare([
    shareToolRow({
      rowId: 1,
      toolName: "Read",
      input: { file_path: "/remote/workspace/src/app.ts" },
      status: "success",
    }),
  ]);
  assert.ok(markup.includes('data-conversation-share-turn="turn-1"'));
  assert.ok(markup.includes('data-conversation-share-row-kind="toolCall"'));
  assert.ok(markup.includes("读取文件"));
  assert.ok(markup.includes("/remote/workspace/src/app.ts"));
});

test("分享只读渲染：pendingApproval 不显示执行中的动作", () => {
  const markup = renderShare([
    shareToolRow({
      rowId: 1,
      toolName: "WebSearch",
      input: { query: "approval pending" },
      status: "pendingApproval",
    }),
  ]);
  assert.ok(markup.includes("搜索网页"));
  assert.ok(!markup.includes("搜索网页中"));
  assert.ok(markup.includes("approval pending"));
});

test("分享只读渲染：失败、拒绝与取消状态在摘要中保持可见", () => {
  const deniedReason = "Permission denied for this request";
  const markup = renderShare([
    shareToolRow({
      rowId: 1,
      toolName: "WebSearch",
      input: { query: "failed" },
      status: "error",
      output: { text: "failed detail" },
    }),
    shareToolRow({
      rowId: 2,
      toolName: "Grep",
      input: { pattern: "denied" },
      status: "cancelled",
      permissionDenial: { decision: "deny", reason: deniedReason },
    }),
    shareToolRow({
      rowId: 3,
      toolName: "WebFetch",
      input: { url: "https://example.com/cancelled" },
      status: "cancelled",
    }),
  ]);
  assert.ok(markup.includes("搜索网页"));
  assert.ok(markup.includes("搜索文件内容"));
  assert.ok(markup.includes("读取网页"));
  assert.ok(!markup.includes("搜索网页中"));
  assert.ok(!markup.includes("搜索文件内容中"));
  assert.ok(!markup.includes("读取网页中"));
  assert.ok(markup.includes("执行失败"));
  assert.ok(markup.includes("已拒绝"));
  assert.ok(markup.includes("已停止"));
});
