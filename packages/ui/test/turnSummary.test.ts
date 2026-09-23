import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantTextRow, ReasoningRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { buildAssistantWorkRenderItems } from "../src/v4/conversationAssistantWorkItems.js";
import {
  formatTurnSummaryText,
  type TurnSummaryCounts,
} from "../src/v4/conversationTurnSummary.js";

// 回合过程汇总（Cursor 式过程收起）：连续过程行折成一行计数，正文/子智能体等必须原样铺开。

const SHOW_REASONING = { messageStreamShowReasoning: true } as const;

function toolRow(options: {
  rowId: number;
  toolName: string;
  input?: unknown;
  status?: ToolCallRow["status"];
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
  };
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

const GREP_ROW = toolRow({ rowId: 1, toolName: "Grep", input: { pattern: "foo" } });
const READ_ROW = toolRow({ rowId: 2, toolName: "Read", input: { file_path: "/tmp/a" } });
// shell 家族一律归「终端」，与卡片上的「终端」标签同源；只读与否不再影响归档。
const READONLY_BASH_ROW = toolRow({ rowId: 3, toolName: "Bash", input: { command: "ls -la" } });
const BASH_ROW = toolRow({ rowId: 4, toolName: "Bash", input: { command: "rm -rf /tmp/x" } });
const WRITE_ROW = toolRow({ rowId: 5, toolName: "Write", input: { file_path: "/tmp/b" } });

function summaryOf(rows: Parameters<typeof buildAssistantWorkRenderItems>[0], running = false) {
  const items = buildAssistantWorkRenderItems(rows, SHOW_REASONING, {
    stageTailIsRunning: running,
  });
  const summary = items.find((item) => item.kind === "turnSummary");
  assert.ok(summary, "应当折叠出一行汇总");
  return { items, summary };
}

test("连续过程行折成一行，计数覆盖查阅/终端/编辑/思考四类", () => {
  const { items, summary } = summaryOf([GREP_ROW, READ_ROW, BASH_ROW, WRITE_ROW, reasoningRow(6)]);

  assert.equal(items.length, 1);
  assert.deepEqual(summary.counts, { explore: 2, terminal: 1, changes: 1, reasoning: 1 });
  // 两条连续只读工具先被聚成 exploreGroup，再整体折进汇总；写入行因分组默认关闭保持单行。
  assert.deepEqual(
    summary.nodes.map((node) => node.kind),
    ["exploreGroup", "row", "row", "row"],
  );
});

test("单条过程行同样折叠", () => {
  const { items, summary } = summaryOf([BASH_ROW]);
  assert.equal(items.length, 1);
  assert.deepEqual(summary.counts, { explore: 0, terminal: 1, changes: 0, reasoning: 0 });
});

test("只读 shell 命令同样计入终端，不因只读改判成查阅", () => {
  const { summary } = summaryOf([READONLY_BASH_ROW]);
  assert.deepEqual(summary.counts, { explore: 0, terminal: 1, changes: 0, reasoning: 0 });
});

test("正文把过程切成两段，正文自身不被折进汇总", () => {
  const { items } = summaryOf([GREP_ROW, assistantTextRow(7), BASH_ROW]);

  assert.deepEqual(
    items.map((item) => item.kind),
    ["turnSummary", "row", "turnSummary"],
  );
  const middle = items[1];
  assert.ok(middle && middle.kind === "row" && middle.row.kind === "assistantText");
});

test("写入工具计入编辑桶（changesGroup 分组关闭时也成立）", () => {
  // ENABLE_CHANGES_TOOL_CALL_GROUPING 默认 false，写入行以单行形态存在。
  const { summary } = summaryOf([WRITE_ROW, toolRow({ rowId: 6, toolName: "Edit" })]);
  assert.equal(summary.counts.changes, 2);
  assert.equal(summary.counts.terminal, 0);
  assert.equal(summary.counts.explore, 0);
});

test("相邻两条终端各自成行，计数仍按条数计", () => {
  // 终端不参与分组：会话里的终端分组只可能藏在汇总内部，等于第二道折叠。
  const { summary } = summaryOf([
    BASH_ROW,
    toolRow({ rowId: 5, toolName: "Bash", input: { command: "mkdir -p /tmp/y" } }),
  ]);

  assert.equal(summary.counts.terminal, 2);
  assert.deepEqual(
    summary.nodes.map((node) => node.kind),
    ["row", "row"],
  );
});

test("无法归类的 shell 行留在汇总之外，不被静默计入某个桶", () => {
  // 命令还没到的 shell 行（input 为空）既不是查阅也不是终端：宁可多显示一行，
  // 也不要把它藏进「终端 N 次」里。
  const pendingShell = toolRow({ rowId: 8, toolName: "Bash", status: "success" });
  const { items, summary } = summaryOf([READONLY_BASH_ROW, pendingShell]);
  assert.deepEqual(summary.counts, { explore: 0, terminal: 1, changes: 0, reasoning: 0 });
  assert.deepEqual(
    items.map((item) => item.kind),
    ["turnSummary", "row"],
  );
});

test("只有位于运行段末尾的汇总才是 running", () => {
  const tail = summaryOf([GREP_ROW, BASH_ROW], true);
  assert.equal(tail.summary.running, true);

  // 后面还有正文时，这一段过程已经结束，不该继续强制展开。
  const head = summaryOf([GREP_ROW, BASH_ROW, assistantTextRow(7)], true);
  const first = head.items[0];
  assert.ok(first && first.kind === "turnSummary");
  assert.equal(first.running, false);
});

test("关闭折叠时输出与改动前一致（逐行铺开）", () => {
  const items = buildAssistantWorkRenderItems([READ_ROW, BASH_ROW], SHOW_REASONING, {
    enableTurnSummary: false,
  });
  assert.deepEqual(
    items.map((item) => item.kind),
    ["row", "row"],
  );
});

test("formatTurnSummaryText：跳过零值桶并按查阅-终端-编辑-思考顺序拼接", () => {
  const intl = {
    formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
      `${id.replace("chat.toolCall.turnSummary.", "")}=${String(values?.count ?? "")}`,
  };
  const counts: TurnSummaryCounts = { explore: 2, terminal: 0, changes: 1, reasoning: 3 };
  assert.equal(
    formatTurnSummaryText(intl, counts),
    "explore.other=2 · changes.one=1 · reasoning.other=3",
  );
  assert.equal(
    formatTurnSummaryText(intl, { explore: 0, terminal: 0, changes: 0, reasoning: 0 }),
    "",
  );
});
