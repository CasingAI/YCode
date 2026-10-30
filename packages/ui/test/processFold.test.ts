import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssistantTextRow, ReasoningRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider, useZCodeIntl } from "../src/i18n/IntlProvider.js";
import { ExploreToolCallBlock } from "../src/ToolCallBlocks/renderers/explore.js";
import { ReadToolCallBlock } from "../src/ToolCallBlocks/renderers/read.js";
import { SearchToolCallBlock } from "../src/ToolCallBlocks/renderers/search.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";
import { classifyToolCallActivity } from "../src/lib/toolCallActivity.js";
import { buildAssistantWorkRenderItems } from "../src/v4/conversationAssistantWorkItems.js";
import { toolCallRowToLegacyNode } from "../src/v4/toolCallRowAdapter.js";
import { formatProcessText, type ProcessCounts } from "../src/v4/conversationProcess.js";

// 回合过程行（Cursor 式过程收起）：连续过程行折成一行计数，正文/子智能体等必须原样铺开。

function toolRow(options: {
  rowId: number;
  toolName: string;
  input?: unknown;
  status?: ToolCallRow["status"];
  permissionDenial?: ToolCallRow["permissionDenial"];
}): ToolCallRow {
  return {
    kind: "toolCall",
    rowId: options.rowId,
    turnId: "turn-1",
    createdAt: options.rowId,
    createdAtSeq: options.rowId,
    toolCallId: `call-${options.rowId}`,
    toolName: options.toolName,
    status: options.status ?? "success",
    inputText: "",
    input: options.input ?? {},
    ...(options.permissionDenial ? { permissionDenial: options.permissionDenial } : {}),
  };
}

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
        error: failed ? "Request failed" : undefined,
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
      options.statusLabel ?? (failed ? "执行失败" : options.isRunning ? "运行中" : "已完成"),
    errorText: failed ? "Request failed" : undefined,
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

function reasoningRow(rowId: number, text = "thinking"): ReasoningRow {
  return {
    kind: "reasoning",
    rowId,
    turnId: "turn-1",
    createdAt: rowId,
    createdAtSeq: rowId,
    text,
    state: "complete",
  };
}

function assistantTextRow(rowId: number): AssistantTextRow {
  return {
    kind: "assistantText",
    rowId,
    turnId: "turn-1",
    createdAt: rowId,
    createdAtSeq: rowId,
    text: "答复",
    state: "complete",
  };
}

const GREP_ROW = toolRow({
  rowId: 1,
  toolName: "Grep",
  input: { pattern: "foo" },
});
const READ_ROW = toolRow({
  rowId: 2,
  toolName: "Read",
  input: { file_path: "/tmp/a" },
});
// shell 家族一律归「终端」，与卡片上的「终端」标签同源；只读与否不再影响归档。
const READONLY_BASH_ROW = toolRow({
  rowId: 3,
  toolName: "Bash",
  input: { command: "ls -la" },
});
const BASH_ROW = toolRow({
  rowId: 4,
  toolName: "Bash",
  input: { command: "rm -rf /tmp/x" },
});
const WRITE_ROW = toolRow({
  rowId: 5,
  toolName: "Write",
  input: { file_path: "/tmp/b" },
});
// 沙盒与 Bash 是并列执行工具：参与同一段过程折叠，但保持独立桶与自己的卡片。
const JSVM_ROW = toolRow({
  rowId: 11,
  toolName: "JSVM",
  input: { description: "算一下", code: "return 1+1;" },
});
const SANDBOX_ALIAS_ROW = toolRow({
  rowId: 12,
  toolName: "Sandbox",
  input: { description: "历史别名", code: "return 2;" },
});

const EMPTY_COUNTS = {
  "file-search": 0,
  "file-find": 0,
  "directory-list": 0,
  "file-read": 0,
  "web-search": 0,
  "web-read": 0,
  terminal: 0,
  sandbox: 0,
  changes: 0,
  reasoning: 0,
} as const;

function processRowOf(rows: Parameters<typeof buildAssistantWorkRenderItems>[0], running = false) {
  const items = buildAssistantWorkRenderItems(rows, {
    stageTailIsRunning: running,
  });
  const processRow = items.find((item) => item.kind === "process");
  assert.ok(processRow, "应当折叠出过程行");
  return { items, processRow };
}

test("连续过程行折成一行，分别统计六种查阅活动及终端/编辑/思考", () => {
  const { items, processRow } = processRowOf([
    GREP_ROW,
    toolRow({ rowId: 7, toolName: "Glob", input: { pattern: "**/*.ts" } }),
    toolRow({ rowId: 8, toolName: "Read", input: { path: "/tmp", type: "directory" } }),
    READ_ROW,
    toolRow({ rowId: 9, toolName: "WebSearch", input: { query: "search" } }),
    toolRow({ rowId: 10, toolName: "WebFetch", input: { url: "https://bing.com/search?q=x" } }),
    BASH_ROW,
    WRITE_ROW,
    reasoningRow(6),
  ]);

  assert.equal(items.length, 1);
  assert.deepEqual(processRow.counts, {
    "file-search": 1,
    "file-find": 1,
    "directory-list": 1,
    "file-read": 1,
    "web-search": 1,
    "web-read": 1,
    terminal: 1,
    sandbox: 0,
    changes: 1,
    reasoning: 1,
  });
  // 查阅工具不再合成 Explore 容器：连续过程行只被过程行收成一行计数，
  // 内部每条工具行保持独立 row，且严格保留原始行序。
  assert.deepEqual(
    processRow.nodes.map((node) => node.kind),
    ["row", "row", "row", "row", "row", "row", "row", "row", "row"],
  );
  assert.deepEqual(
    processRow.nodes.map((node) => {
      if (node.kind !== "row") return node.kind;
      return node.row.kind === "toolCall" ? node.row.toolName : node.row.kind;
    }),
    ["Grep", "Glob", "Read", "Read", "WebSearch", "WebFetch", "Bash", "Write", "reasoning"],
  );
});

test("含权限拒绝的查阅行自身保留 denied，不被聚合成 stopped 或 completed", () => {
  const denied = toolRow({
    rowId: 7,
    toolName: "Grep",
    input: { pattern: "blocked" },
    status: "cancelled",
    permissionDenial: { decision: "deny", reason: "Ask mode denied this tool" },
  });
  const { processRow } = processRowOf([denied, READ_ROW]);
  assert.equal(processRow.nodes.length, 2);
  const deniedNode = processRow.nodes[0];
  assert.ok(deniedNode && deniedNode.kind === "row" && deniedNode.row.kind === "toolCall");
  // 拒绝语义仍落在被拒绝的那条工具行上：permissionDenial 在行上，旧节点状态映射为
  // denied，而不是被容器聚合成 stopped/completed。
  assert.equal(deniedNode.row.permissionDenial?.decision, "deny");
  const legacyNode = toolCallRowToLegacyNode(deniedNode.row);
  assert.equal(legacyNode.toolCall.status, "denied");
  assert.notEqual(legacyNode.toolCall.status, "stopped");
  assert.notEqual(legacyNode.toolCall.status, "completed");
  const secondNode = processRow.nodes[1];
  assert.ok(secondNode && secondNode.kind === "row" && secondNode.row.kind === "toolCall");
  assert.equal(secondNode.row.toolName, "Read");
});

test("单条过程行同样折叠", () => {
  const { items, processRow } = processRowOf([BASH_ROW]);
  assert.equal(items.length, 1);
  assert.deepEqual(processRow.counts, {
    ...EMPTY_COUNTS,
    terminal: 1,
  });
});

test("只读 shell 命令同样计入终端，不因只读改判成查阅", () => {
  const { processRow } = processRowOf([READONLY_BASH_ROW]);
  assert.deepEqual(processRow.counts, {
    ...EMPTY_COUNTS,
    terminal: 1,
  });
});

test("正文把过程切成两段，正文自身不被折进过程行", () => {
  const { items } = processRowOf([GREP_ROW, assistantTextRow(7), BASH_ROW]);

  assert.deepEqual(
    items.map((item) => item.kind),
    ["process", "row", "process"],
  );
  const middle = items[1];
  assert.ok(middle && middle.kind === "row" && middle.row.kind === "assistantText");
});

test("写入工具计入编辑桶", () => {
  // 写入行与终端行同款单行铺开，不折出「更改」容器；过程计数仍按条数计。
  const { processRow } = processRowOf([WRITE_ROW, toolRow({ rowId: 6, toolName: "Edit" })]);
  assert.equal(processRow.counts.changes, 2);
  assert.equal(processRow.counts.terminal, 0);
  assert.equal(processRow.counts["file-search"], 0);
});

test("相邻两条终端各自成行，计数仍按条数计", () => {
  // 终端不参与分组：会话里的终端分组只可能藏在过程行内部，等于第二道折叠。
  const { processRow } = processRowOf([
    BASH_ROW,
    toolRow({
      rowId: 5,
      toolName: "Bash",
      input: { command: "mkdir -p /tmp/y" },
    }),
  ]);

  assert.equal(processRow.counts.terminal, 2);
  assert.deepEqual(
    processRow.nodes.map((node) => node.kind),
    ["row", "row"],
  );
});

test("Bash → JSVM → Bash 属同一连续段，沙盒不把终端切成两段", () => {
  const { items, processRow } = processRowOf([BASH_ROW, JSVM_ROW, READONLY_BASH_ROW]);

  // 沙盒与终端并列参与折叠：仍是同一个过程段，而不是 process / row / process。
  assert.equal(items.length, 1);
  assert.deepEqual(processRow.counts, {
    ...EMPTY_COUNTS,
    terminal: 2,
    sandbox: 1,
  });
  assert.deepEqual(
    processRow.nodes.map((node) => {
      if (node.kind !== "row") return node.kind;
      return node.row.kind === "toolCall" ? node.row.toolName : node.row.kind;
    }),
    ["Bash", "JSVM", "Bash"],
  );
});

test("历史 Sandbox 别名与现役 JSVM 同归沙盒桶，不计入终端或查阅", () => {
  const { items, processRow } = processRowOf([SANDBOX_ALIAS_ROW, JSVM_ROW]);

  assert.equal(items.length, 1);
  assert.deepEqual(processRow.counts, {
    ...EMPTY_COUNTS,
    sandbox: 2,
  });
  assert.equal(processRow.counts.terminal, 0);
  assert.equal(processRow.counts["file-read"], 0);
  assert.equal(processRow.counts["file-search"], 0);
  assert.equal(processRow.counts.changes, 0);
});

test("沙盒单行同样折叠，并按真实调用次数显示「沙盒」", () => {
  const { items, processRow } = processRowOf([JSVM_ROW]);
  assert.equal(items.length, 1);
  assert.deepEqual(processRow.counts, {
    ...EMPTY_COUNTS,
    sandbox: 1,
  });
});

test("无法归类的 shell 行留在过程行之外，不被静默计入某个桶", () => {
  // 命令还没到的 shell 行（input 为空）既不是查阅也不是终端：宁可多显示一行，
  // 也不要把它藏进「终端 N 次」里。
  const pendingShell = toolRow({
    rowId: 8,
    toolName: "Bash",
    status: "success",
  });
  const { items, processRow } = processRowOf([READONLY_BASH_ROW, pendingShell]);
  assert.deepEqual(processRow.counts, {
    ...EMPTY_COUNTS,
    terminal: 1,
  });
  assert.deepEqual(
    items.map((item) => item.kind),
    ["process", "row"],
  );
});

test("只有位于运行段末尾的过程行才是 running", () => {
  const tail = processRowOf([GREP_ROW, BASH_ROW], true);
  assert.equal(tail.processRow.running, true);

  // 后面还有正文时，这一段过程已经结束，不该继续强制展开。
  const head = processRowOf([GREP_ROW, BASH_ROW, assistantTextRow(7)], true);
  const first = head.items[0];
  assert.ok(first && first.kind === "process");
  assert.equal(first.running, false);
});

test("关闭折叠时输出与改动前一致（逐行铺开）", () => {
  const items = buildAssistantWorkRenderItems([READ_ROW, BASH_ROW], {
    enableProcess: false,
  });
  assert.deepEqual(
    items.map((item) => item.kind),
    ["row", "row"],
  );
});

test("formatProcessText：跳过零值桶并按文件/网页活动-终端-沙盒-编辑-思考顺序拼接", () => {
  const intl = {
    formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
      `${id.replace("chat.toolCall.process.", "")}=${String(values?.count ?? "")}`,
  };
  const counts: ProcessCounts = {
    "file-search": 2,
    "file-find": 1,
    "directory-list": 0,
    "file-read": 0,
    "web-search": 3,
    "web-read": 1,
    terminal: 1,
    sandbox: 2,
    changes: 1,
    reasoning: 3,
  };
  assert.equal(
    formatProcessText(intl, counts),
    "fileSearch.other=2 · fileFind.one=1 · webSearch.other=3 · webRead.one=1 · terminal.one=1 · sandbox.other=2 · changes.one=1 · reasoning.other=3",
  );
  assert.equal(formatProcessText(intl, { ...EMPTY_COUNTS }), "");
});

// 真实 locale 的渲染集成：摘要文案由 i18n 提供，沙盒计数必须出现在过程行文本里。
function ProcessSummaryProbe({ counts }: { counts: ProcessCounts }) {
  const { intl } = useZCodeIntl();
  return createElement("span", null, formatProcessText(intl, counts));
}

test("过程摘要 SSR：中英文均显示真实沙盒调用次数，且不与终端混用文案", () => {
  const counts: ProcessCounts = { ...EMPTY_COUNTS, terminal: 1, sandbox: 2 };
  const render = (locale: "zh-CN" | "en-US") =>
    renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: locale },
        createElement(ProcessSummaryProbe, { counts }),
      ),
    );

  const zh = render("zh-CN");
  assert.ok(zh.includes("终端 1 次"), zh);
  assert.ok(zh.includes("沙盒 2 次"), zh);
  assert.ok(zh.indexOf("终端 1 次") < zh.indexOf("沙盒 2 次"), "终端排在沙盒之前");

  const en = render("en-US");
  assert.ok(en.includes("1 terminal call"), en);
  assert.ok(en.includes("2 sandbox calls"), en);
});

// 回归：普通空 reasoning（例如 Responses 加密块）继续隐藏；只有显式阶段空行才参与
// 可见思考计数。非空思考行不再受设置控制，均参与计数。
function summaryCountsOf(rows: readonly (ReasoningRow | ToolCallRow)[]) {
  const items = buildAssistantWorkRenderItems(rows);
  const processRow = items.find((item) => item.kind === "process");
  assert.ok(processRow, "应当折叠出过程行");
  return processRow.counts;
}

const READ = (rowId: number) =>
  toolRow({ rowId, toolName: "Read", input: { file_path: `/tmp/f${rowId}` } });
const SHELL = (rowId: number) => toolRow({ rowId, toolName: "Bash", input: { command: "ls -la" } });

test("空摘要思考行不计入思考桶，也不在展开后画出空行", () => {
  // 取真实回合的段形状：16 次查阅 + 7 次终端，中间夹 7 条空摘要思考行。
  const rows: (ReasoningRow | ToolCallRow)[] = [reasoningRow(1, ""), SHELL(2)];
  for (let i = 0; i < 7; i += 1) rows.push(READ(10 + i));
  rows.push(reasoningRow(20, ""), SHELL(21));
  for (let i = 0; i < 9; i += 1) rows.push(READ(30 + i));
  rows.push(reasoningRow(40, ""));
  for (let i = 0; i < 5; i += 1) rows.push(SHELL(50 + i));

  const counts = summaryCountsOf(rows);
  assert.equal(counts["file-read"], 16);
  assert.equal(counts.terminal, 7);
  assert.equal(counts.reasoning, 0);
  assert.equal(counts["file-search"], 0);
  assert.equal(counts["web-search"], 0);
  assert.equal(counts["web-read"], 0);
});

test("多条非空思考行始终计入过程行", () => {
  const rows: (ReasoningRow | ToolCallRow)[] = [
    reasoningRow(1, "Examining codebase layout before running checks."),
    SHELL(2),
    reasoningRow(3, "Checking the settings schema."),
    READ(4),
    reasoningRow(5, "Reviewing the render path."),
  ];

  const counts = summaryCountsOf(rows);
  assert.equal(counts.reasoning, 3, "所有有文本的思考行都必须计入");
});

test("活动分类：依据可信身份区分六种活动，URL 或标题不能猜网页类别", () => {
  const classify = (toolName: string, input: unknown = {}, title?: string, raw?: unknown) =>
    classifyToolCallActivity({ toolName, input, title, raw });

  assert.equal(classify("Grep", { pattern: "https://example.com" }), "file-search");
  assert.equal(classify("Glob", { pattern: "src/**/*.ts" }), "file-find");
  assert.equal(classify("Read", { path: "/workspace", type: "directory" }), "directory-list");
  assert.equal(classify("Read", { file_path: "/workspace/readme.md" }), "file-read");
  assert.equal(
    classify("Read", { file_path: "/workspace/src" }, undefined, {
      rawOutput: "<type>directory</type>",
    }),
    "directory-list",
  );
  assert.equal(
    classify("Read", { file_path: "/workspace/src" }, undefined, {
      rawInput: { file_path: "/workspace/src" },
      rawOutput: { content: "<type>directory</type>" },
    }),
    "directory-list",
  );
  assert.equal(
    classify("Read", { file_path: "/workspace/src" }, undefined, {
      content: [{ type: "text", text: "<type>directory</type>" }],
    }),
    "directory-list",
  );
  assert.equal(classify("WebSearch", { query: "find src files" }), "web-search");
  assert.equal(classify("WebFetch", { url: "https://www.bing.com/search?q=anything" }), "web-read");
  assert.equal(classify("OldTool", { url: "https://example.com" }, "WebSearch"), "unknown");
  assert.equal(classify("OldTool", { query: "https://example.com" }), "unknown");
});

test("普通工具行 SSR：文件与网页活动标签区分，文件操作保留远端工作区路径", () => {
  const cases = [
    { toolName: "Grep", input: { pattern: "needle" }, label: "搜索文件内容", target: "needle" },
    {
      toolName: "Glob",
      input: { pattern: "src/**/*.ts" },
      label: "查找文件",
      target: "src/**/*.ts",
    },
    {
      toolName: "Read",
      input: { file_path: "/remote/workspace/readme.md" },
      label: "读取文件",
      target: "readme.md",
    },
    { toolName: "WebSearch", input: { query: "YCode" }, label: "搜索网页", target: "YCode" },
    {
      toolName: "WebFetch",
      input: { url: "https://www.bing.com/search?q=YCode" },
      label: "读取网页",
      target: "https://www.bing.com/search?q=YCode",
    },
  ];

  for (const item of cases) {
    const markup = renderTool(
      SearchToolCallBlock,
      toolRenderContext({ toolName: item.toolName, input: item.input }),
    );
    assert.ok(markup.includes(item.label), `${item.toolName} 应呈现 ${item.label}`);
    assert.ok(markup.includes(item.target), `${item.toolName} 应呈现目标值`);
  }

  const remoteRead = renderTool(
    ReadToolCallBlock,
    toolRenderContext({ toolName: "Read", input: { file_path: "/remote/workspace/readme.md" } }),
  );
  assert.ok(remoteRead.includes("/remote/workspace/readme.md"));
  assert.ok(remoteRead.includes("读取文件"));
});

test("Explore 组 SSR：展开分组计数使用 spec 文案且文件组在网页组之前", () => {
  const children = [
    { toolName: "Grep", kind: "Grep", input: { pattern: "needle" } },
    { toolName: "Read", kind: "Read", input: { file_path: "/remote/workspace/a.ts" } },
    { toolName: "WebSearch", kind: "WebSearch", input: { query: "needle" } },
    {
      toolName: "WebFetch",
      kind: "WebFetch",
      input: { url: "https://www.bing.com/search?q=needle" },
    },
  ];
  const markup = renderTool(ExploreToolCallBlock, {
    ...toolRenderContext({ toolName: "Explore", input: {} }),
    toolCallNode: {
      childToolCalls: children.map((child, index) => ({
        toolCall: {
          toolId: `child-${index}`,
          ...child,
          title: child.toolName,
          status: "completed",
        },
      })),
      toolCall: {
        toolId: "explore-group",
        toolName: "Explore",
        kind: "Explore",
        title: "Explore",
        input: {},
        status: "completed",
      },
    },
  });
  const contentSearch = "1 次内容搜索";
  const fileRead = "1 次文件读取";
  const webSearch = "1 次网页搜索";
  const webRead = "1 次网页读取";
  for (const expected of [contentSearch, fileRead, webSearch, webRead]) {
    assert.ok(markup.includes(expected), `Explore 分组摘要应显示 ${expected}`);
  }
  assert.ok(markup.indexOf(contentSearch) < markup.indexOf(webSearch));
});

test("Explore 运行摘要组合父级组别与具体动作，不重复类别词", () => {
  const renderRunningExplore = (childStatus: string) =>
    renderTool(ExploreToolCallBlock, {
      ...toolRenderContext({
        toolName: "Explore",
        input: {},
        status: "in_progress",
        isRunning: true,
      }),
      toolCallNode: {
        childToolCalls: [
          {
            toolCall: {
              toolId: "web-search-child",
              toolName: "WebSearch",
              kind: "WebSearch",
              title: "WebSearch",
              input: { query: "needle" },
              status: childStatus,
            },
          },
        ],
        toolCall: {
          toolId: "explore-running",
          toolName: "Explore",
          kind: "Explore",
          title: "Explore",
          input: {},
          status: "in_progress",
        },
      },
    });

  const runningMarkup = renderRunningExplore("running");
  assert.match(runningMarkup, /<span class="tool-summary-kind-label[^>]*>网页查阅<\/span>/);
  assert.match(runningMarkup, /<span class="min-w-0 truncate">搜索网页中 needle<\/span>/);
  const childSummary = runningMarkup.slice(
    runningMarkup.indexOf('data-testid="tool-summary-trigger-explore-running"'),
  );
  assert.equal((childSummary.match(/网页查阅/g) ?? []).length, 1);
  assert.ok(!childSummary.includes("网页查阅 搜索网页中"));

  const completedChildMarkup = renderRunningExplore("success");
  assert.ok(completedChildMarkup.includes("网页查阅"));
  assert.ok(completedChildMarkup.includes("搜索网页 needle"));
  assert.ok(!completedChildMarkup.includes("搜索网页中"));
});

test("普通工具行 SSR：进行态使用中性动作后缀，错误仍保留失败状态", () => {
  const running = renderTool(
    SearchToolCallBlock,
    toolRenderContext({
      toolName: "WebFetch",
      input: { url: "https://example.com" },
      isRunning: true,
      status: "running",
    }),
  );
  assert.ok(running.includes("读取网页中"));
  assert.ok(!running.includes("正在"));

  const failed = renderTool(
    SearchToolCallBlock,
    toolRenderContext({
      toolName: "WebSearch",
      input: { query: "failed query" },
      status: "failed",
    }),
  );
  assert.ok(failed.includes("搜索网页"));
  assert.ok(failed.includes("执行失败"));
  assert.ok(!failed.includes("搜索网页中"));

  const waiting = renderTool(
    SearchToolCallBlock,
    toolRenderContext({
      toolName: "WebSearch",
      input: { query: "queued query" },
      status: "queued",
      statusLabel: "等待中",
      isRunning: false,
    }),
  );
  assert.ok(waiting.includes("搜索网页"));
  assert.ok(waiting.includes("queued query"));
  assert.ok(!waiting.includes("搜索网页中"));

  for (const status of ["pending", "inputStreaming"] as const) {
    const notYetRunning = renderTool(
      SearchToolCallBlock,
      toolRenderContext({
        toolName: "WebSearch",
        input: { query: "admission only" },
        status,
        statusLabel: "等待中",
        isRunning: true,
      }),
    );
    assert.ok(notYetRunning.includes("搜索网页"));
    assert.ok(!notYetRunning.includes("搜索网页中"));
  }
});

test("Read 目录 SSR：明确目录类型显示列目录动作，而不呈现文件读取", () => {
  const markup = renderTool(
    ReadToolCallBlock,
    toolRenderContext({
      toolName: "Read",
      input: { file_path: "/remote/workspace/src", type: "directory" },
    }),
  );
  assert.ok(markup.includes("列出目录"));
  assert.ok(!markup.includes("读取文件"));
});

test("英文 SSR：网页搜索与文件读取使用明确类别和自然进行时", () => {
  const webRunning = renderTool(
    SearchToolCallBlock,
    toolRenderContext({
      toolName: "WebSearch",
      input: { query: "query" },
      status: "running",
      isRunning: true,
    }),
    "en-US",
  );
  const fileRunning = renderTool(
    ReadToolCallBlock,
    toolRenderContext({
      toolName: "Read",
      input: { file_path: "/remote/workspace/a.ts" },
      status: "running",
      isRunning: true,
    }),
    "en-US",
  );
  assert.ok(webRunning.includes("Searching the web"));
  assert.ok(fileRunning.includes("Reading file"));
});

test("关闭过程折叠时，多条思考行仍逐条输出", () => {
  const items = buildAssistantWorkRenderItems(
    [reasoningRow(1, "第一段思考"), reasoningRow(2, "第二段思考")],
    { enableProcess: false },
  );

  assert.deepEqual(
    items.map((item) => item.kind),
    ["row", "row"],
  );
});
