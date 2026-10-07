import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  HistoryListToolCallBlock,
  HistoryReadToolCallBlock,
  HistorySearchToolCallBlock,
  formatQueryPreview,
  historyListSummaryText,
  historyReadSummaryText,
  historySearchSummaryText,
  readSearchQueryFromInput,
  type HistorySummaryFormat,
} from "../src/ToolCallBlocks/renderers/history.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";

// 会话存档三卡（HistoryList / HistorySearch / HistoryRead）：折叠行摘要拼装 + display
// 缺席降级 + 展开文本投影。卡面规则见 docs/specs/session-history-tools.md「聊天工具卡」。

const zhFormat: HistorySummaryFormat = (descriptor, values) => {
  const messages: Record<string, string> = {
    "chat.toolCall.history.failed": "调用失败",
    "chat.toolCall.history.list.empty": "没有符合条件的会话",
    "chat.toolCall.history.list.count": "{count} 个会话",
    "chat.toolCall.history.list.countOne": "{count} 个会话",
    "chat.toolCall.history.search.noHits": "{query} · 无命中",
    "chat.toolCall.history.search.count": "{count} 个命中",
    "chat.toolCall.history.search.countOne": "{count} 个命中",
    "chat.toolCall.history.search.notFound": "会话不存在",
    "chat.toolCall.history.read.notFound": "会话不存在",
    "chat.toolCall.history.read.titled": "《{title}》",
  };
  const template = messages[descriptor.id] ?? descriptor.id;
  return template.replace(/\{(\w+)\}/g, (_match, key: string) =>
    values && key in values ? String(values[key]) : `{${key}}`,
  );
};

function buildContext(overrides: {
  toolName: string;
  input?: unknown;
  output?: unknown;
  raw?: unknown;
  forceOpen?: boolean;
}): ToolCallBlockRenderContext {
  return {
    toolCallNode: {
      childToolCalls: [],
      toolCall: {
        toolId: `history-${overrides.toolName}`,
        toolName: overrides.toolName,
        kind: "",
        input: overrides.input ?? {},
        output: overrides.output,
        raw: overrides.raw,
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
    statusLabel: "已完成",
    childToolList: null,
    canToggle: true,
    forceOpen: overrides.forceOpen ?? false,
  };
}

function renderCard(
  component: (context: ToolCallBlockRenderContext) => React.ReactNode,
  overrides: { toolName: string; input?: unknown; output?: unknown; raw?: unknown; forceOpen?: boolean },
): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(component, buildContext(overrides)),
    ),
  );
}

test("HistoryList 摘要：scopeNote 与计数拼接", () => {
  assert.equal(
    historyListSummaryText(
      { kind: "history_list", status: "success", scopeNote: "最近 7 天", sessionCount: 5 },
      zhFormat,
    ),
    "最近 7 天 · 5 个会话",
  );
});

test("HistoryList 摘要：空结果、失败与 display 缺席", () => {
  assert.equal(
    historyListSummaryText(
      { kind: "history_list", status: "success", sessionCount: 0 },
      zhFormat,
    ),
    "没有符合条件的会话",
  );
  assert.equal(
    historyListSummaryText({ kind: "history_list", status: "failed", sessionCount: 0 }, zhFormat),
    "调用失败",
  );
  assert.equal(historyListSummaryText(undefined, zhFormat), undefined);
});

test("HistorySearch 摘要：命中数、无命中与 not_found", () => {
  assert.equal(
    historySearchSummaryText(
      { kind: "history_search", status: "success", query: "历史", hitCount: 3 },
      zhFormat,
    ),
    '"历史" · 3 个命中',
  );
  assert.equal(
    historySearchSummaryText(
      { kind: "history_search", status: "success", query: "历史", hitCount: 0 },
      zhFormat,
    ),
    '"历史" · 无命中',
  );
  assert.equal(
    historySearchSummaryText(
      { kind: "history_search", status: "not_found", query: "历史", hitCount: 0 },
      zhFormat,
    ),
    "会话不存在",
  );
});

test("HistoryRead 摘要：只显示读了哪个会话（标题或 sessionId），无坐标细节", () => {
  assert.equal(
    historyReadSummaryText(
      {
        kind: "history_read",
        status: "success",
        title: "重构 History 工具卡",
        sessionId: "sess_abc123",
      },
      zhFormat,
    ),
    "《重构 History 工具卡》",
  );
  assert.equal(
    historyReadSummaryText(
      { kind: "history_read", status: "success", sessionId: "sess_abc123" },
      zhFormat,
    ),
    "sess_abc123",
  );
  assert.equal(
    historyReadSummaryText(
      { kind: "history_read", status: "not_found", sessionId: "sess_abc123" },
      zhFormat,
    ),
    "会话不存在",
  );
});

test("query 预览超 24 字符截断", () => {
  assert.equal(formatQueryPreview("历史"), '"历史"');
  const long = "词".repeat(30);
  const preview = formatQueryPreview(long);
  assert.equal(preview.startsWith('"'), true);
  assert.equal(preview.endsWith('…"'), true);
  assert.equal(Array.from(preview).length, 24 + 3);
});

test("search 输入兜底：display 缺席时折叠行仍显示关键词", () => {
  assert.equal(readSearchQueryFromInput({ query: "历史" }), "历史");
  assert.equal(readSearchQueryFromInput({ query: "   " }), undefined);
  assert.equal(readSearchQueryFromInput({}), undefined);
  assert.equal(readSearchQueryFromInput("not-a-record"), undefined);

  // 无 display、仅有输入：折叠行给出 "关键词"。
  const markup = renderCard(HistorySearchToolCallBlock, {
    toolName: "HistorySearch",
    input: { query: "历史" },
  });
  assert.match(markup, /搜索会话/);
  assert.match(markup, /&quot;历史&quot;/);
  // 无结果文本，不可展开：不出箭头内容。
  assert.equal(markup.includes("history_search"), false);
});

test("折叠 HistoryList 卡：display 缺席只剩 kindLabel，不出 raw JSON", () => {
  const markup = renderCard(HistoryListToolCallBlock, {
    toolName: "HistoryList",
    output: "最近 7 天 · 命中 5 个会话",
  });
  assert.match(markup, /列出会话/);
  assert.equal(markup.includes("history_list"), false);
});

test("折叠 HistoryList 卡：display 在场时折叠行给出计数摘要", () => {
  const markup = renderCard(HistoryListToolCallBlock, {
    toolName: "HistoryList",
    output: "最近 7 天 · 命中 5 个会话",
    raw: { display: { kind: "history_list", status: "success", scopeNote: "最近 7 天", sessionCount: 5 } },
  });
  assert.match(markup, /列出会话/);
  assert.match(markup, /最近 7 天 · 5 个会话/);
});

test("展开 HistorySearch 卡：显示文本投影与 truncated 尾注", () => {
  const markup = renderCard(HistorySearchToolCallBlock, {
    toolName: "HistorySearch",
    output: "命中片段文本投影",
    raw: { display: { kind: "history_search", status: "success", query: "历史", hitCount: 3, truncated: true } },
    forceOpen: true,
  });
  assert.match(markup, /搜索会话/);
  // renderToStaticMarkup 会把直引号转义成 &quot;。
  assert.match(markup, /&quot;历史&quot; · 3 个命中/);
  assert.match(markup, /命中片段文本投影/);
  assert.match(markup, /仅显示部分命中/);
});

test("折叠 HistoryRead 卡：折叠行带 sessionId 签（展开时隐藏）", () => {
  const markup = renderCard(HistoryReadToolCallBlock, {
    toolName: "HistoryRead",
    output: "会话原文……",
    raw: {
      display: {
        kind: "history_read",
        status: "success",
        title: "重构 History 工具卡",
        sessionId: "sess_abc123",
      },
    },
  });
  assert.match(markup, /《重构 History 工具卡》/);
  assert.match(markup, /sess_abc123/);
  // 折叠态不渲染正文。
  assert.equal(markup.includes("会话原文……"), false);
});

test("展开 HistoryRead 卡：显示原文投影；sessionId 签按 hideSecondaryTextWhenOpen 隐藏", () => {
  const markup = renderCard(HistoryReadToolCallBlock, {
    toolName: "HistoryRead",
    output: "会话原文……",
    raw: {
      display: {
        kind: "history_read",
        status: "success",
        title: "重构 History 工具卡",
        sessionId: "sess_abc123",
      },
    },
    forceOpen: true,
  });
  assert.match(markup, /读取会话/);
  assert.match(markup, /《重构 History 工具卡》/);
  assert.match(markup, /会话原文……/);
});
