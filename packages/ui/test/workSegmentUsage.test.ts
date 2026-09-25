import assert from "node:assert/strict";
import test from "node:test";
import type { Locale } from "@zcode/shared";
import type { ReasoningRow, SubagentRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { IntlInstance } from "../src/i18n/IntlProvider.js";
import type { AssistantWorkRow } from "../src/v4/conversationTurnFlowItems.js";
import {
  deriveDirectWorkSegmentUsage,
  formatWorkSegmentUsage,
  resolveWorkSegmentUsage,
} from "../src/v4/conversationWorkSegmentUsage.js";
import { formatConversationWorkDuration } from "../src/v4/conversationWorkDuration.js";

// 状态行总览：`已工作 X · 工具 N 次 · 思考 Y 秒`。
// 权威值来自 CLI 投影的 TurnWorkSegment.usage；旧快照没有该字段时才用当前段可直接证明的统计兜底。

const MESSAGES: Record<Locale, Record<string, string>> = {
  "zh-CN": {
    "chat.history.toolCallCount.one": "工具 {count} 次",
    "chat.history.toolCallCount.other": "工具 {count} 次",
    "chat.history.thinkingDuration": "思考 {duration}",
    "chat.history.duration.second": "秒",
    "chat.history.duration.minute": "分",
    "chat.history.duration.hour": "时",
    "chat.history.duration.day": "天",
  },
  "en-US": {
    "chat.history.toolCallCount.one": "{count} tool call",
    "chat.history.toolCallCount.other": "{count} tool calls",
    "chat.history.thinkingDuration": "Thought for {duration}",
    "chat.history.duration.second": "s",
    "chat.history.duration.minute": "m",
    "chat.history.duration.hour": "h",
    "chat.history.duration.day": "d",
  },
};

function intlFor(locale: Locale): IntlInstance {
  const messages = MESSAGES[locale];
  return {
    formatMessage(descriptor, values) {
      const template = messages[descriptor.id] ?? descriptor.id;
      if (!values) return template;
      return template.replace(/\{(\w+)\}/g, (match, key: string) =>
        key in values ? String(values[key]) : match,
      );
    },
  };
}

let nextRowId = 0;
function toolRow(durationMs?: number): ToolCallRow {
  nextRowId += 1;
  return {
    kind: "toolCall",
    rowId: nextRowId,
    turnId: "turn-1",
    createdAt: nextRowId,
    createdAtSeq: nextRowId,
    toolCallId: `call-${nextRowId}`,
    toolName: "Bash",
    status: "success",
    inputText: "",
    input: {},
    ...(durationMs === undefined ? {} : { durationMs }),
  } as ToolCallRow;
}

function reasoningRow(durationMs?: number): ReasoningRow {
  nextRowId += 1;
  return {
    kind: "reasoning",
    rowId: nextRowId,
    turnId: "turn-1",
    createdAt: nextRowId,
    createdAtSeq: nextRowId,
    text: "thinking",
    state: durationMs === undefined ? "streaming" : "complete",
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function subagentRow(usage?: SubagentRow["usage"]): SubagentRow {
  nextRowId += 1;
  return {
    kind: "subagent",
    rowId: nextRowId,
    turnId: "turn-1",
    createdAt: nextRowId,
    createdAtSeq: nextRowId,
    entityId: `agent-${nextRowId}`,
    subagentType: "general-purpose",
    status: "success",
    summaryText: "",
    ...(usage ? { usage } : {}),
  } as SubagentRow;
}

test("中文状态行显示 工具 7 次 · 思考 18 秒", () => {
  const label = formatWorkSegmentUsage(
    { toolCallCount: 7, reasoningDurationMs: 18_000 },
    intlFor("zh-CN"),
    "zh-CN",
  );

  assert.equal(label, "工具 7 次 · 思考 18 秒");
});

test("英文状态行使用 tool calls 与 Thought for", () => {
  const label = formatWorkSegmentUsage(
    { toolCallCount: 7, reasoningDurationMs: 18_000 },
    intlFor("en-US"),
    "en-US",
  );

  assert.equal(label, "7 tool calls · Thought for 18s");
});

test("单次工具调用使用单数文案", () => {
  assert.equal(
    formatWorkSegmentUsage(
      { toolCallCount: 1, reasoningDurationMs: 4_000 },
      intlFor("en-US"),
      "en-US",
    ),
    "1 tool call · Thought for 4s",
  );
});

test("工具为 0 时整项隐藏，只显示思考耗时", () => {
  assert.equal(
    formatWorkSegmentUsage(
      { toolCallCount: 0, reasoningDurationMs: 2_000 },
      intlFor("zh-CN"),
      "zh-CN",
    ),
    "思考 2 秒",
  );
  assert.equal(
    formatWorkSegmentUsage(
      { toolCallCount: 0, reasoningDurationMs: 2_000 },
      intlFor("en-US"),
      "en-US",
    ),
    "Thought for 2s",
  );
});

test("思考为 0 时整项隐藏，只显示工具次数", () => {
  assert.equal(
    formatWorkSegmentUsage({ toolCallCount: 2, reasoningDurationMs: 0 }, intlFor("zh-CN"), "zh-CN"),
    "工具 2 次",
  );
  assert.equal(
    formatWorkSegmentUsage({ toolCallCount: 2, reasoningDurationMs: 0 }, intlFor("en-US"), "en-US"),
    "2 tool calls",
  );
});

test("两项都为 0 时不渲染，工作段刚建立时不闪「工具 0 次」", () => {
  assert.equal(
    formatWorkSegmentUsage({ toolCallCount: 0, reasoningDurationMs: 0 }, intlFor("zh-CN"), "zh-CN"),
    "",
  );
  assert.equal(
    formatWorkSegmentUsage({ toolCallCount: 0, reasoningDurationMs: 0 }, intlFor("en-US"), "en-US"),
    "",
  );
});

test("权威 usage 优先于本地兜底统计", () => {
  const rows: AssistantWorkRow[] = [toolRow(), toolRow(), reasoningRow(5_000)];
  const usage = resolveWorkSegmentUsage({
    usage: { toolCallCount: 9, reasoningDurationMs: 30_000 },
    rows,
  });

  assert.deepEqual(usage, { toolCallCount: 9, reasoningDurationMs: 30_000 });
});

test("旧快照没有 usage 时只统计当前段可直接证明的调用", () => {
  const rows: AssistantWorkRow[] = [
    toolRow(),
    toolRow(),
    toolRow(),
    reasoningRow(12_000),
    // 旧快照的子代理行没有 usage 字段，不推断它的内部调用。
    subagentRow(undefined),
  ];
  const usage = resolveWorkSegmentUsage({ rows });

  assert.deepEqual(usage, { toolCallCount: 3, reasoningDurationMs: 12_000 });
});

test("子代理行的 usage 合并进兜底统计", () => {
  const rows: AssistantWorkRow[] = [
    toolRow(),
    subagentRow({ toolCallCount: 3, reasoningDurationMs: 20_000 }),
  ];
  const usage = deriveDirectWorkSegmentUsage(rows);

  assert.deepEqual(usage, { toolCallCount: 4, reasoningDurationMs: 20_000 });
});

test("运行中的 reasoning 没有 durationMs 时不计入耗时", () => {
  const usage = deriveDirectWorkSegmentUsage([reasoningRow(undefined)]);
  assert.equal(usage.reasoningDurationMs, 0);
});

test("状态行与展开区的过程分类互不影响：工作时长格式化仍按原规则", () => {
  const intl = intlFor("zh-CN");
  assert.equal(formatConversationWorkDuration(4_680_000, intl, "zh-CN"), "1 时 18 分");
  assert.equal(formatConversationWorkDuration(18_000, intl, "zh-CN"), "18 秒");
});
