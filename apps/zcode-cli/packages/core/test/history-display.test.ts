import assert from "node:assert/strict";
import test from "node:test";
import {
  HISTORY_LIST_TOOL_NAME,
  HISTORY_READ_TOOL_NAME,
  HISTORY_SEARCH_TOOL_NAME,
  parseToolResultDisplayPayload,
} from "@zcode/contracts";
import { toolOutputSchema } from "@zcode/shared/zcode-protocol-v4";
import { createToolResultDisplay } from "../src/tool/executor/result-display.js";

// 会话存档三工具的结果卡载荷：折叠行摘要（计数 / query / 标题 / 段坐标）。
// 规则见 docs/specs/session-history-tools.md「聊天工具卡」。

function historyListOutput(overrides: Record<string, unknown> = {}) {
  return {
    status: "success",
    scopeNote: "最近 7 天 · 已隐藏子代理会话",
    sessions: [
      {
        sessionId: "sess_abc123",
        title: "重构 History 工具卡",
        directory: "/tmp/YCode",
        messageCount: 32,
        timeCreated: 1_700_000_000_000,
        timeUpdated: 1_700_000_100_000,
      },
      {
        sessionId: "sess_def456",
        title: null,
        directory: "/tmp/YCode",
        timeCreated: 1_700_000_000_000,
        timeUpdated: 1_700_000_200_000,
      },
    ],
    ...overrides,
  };
}

function historyReadOutput(overrides: Record<string, unknown> = {}) {
  return {
    status: "success",
    sessionId: "sess_abc123",
    role: "both",
    title: "重构 History 工具卡",
    totalSegments: 120,
    totalChars: 24_000,
    page: { start: 0, end: 24_000, nextOffset: null, viaSegment: 12 },
    content: "会话原文……",
    ...overrides,
  };
}

function historySearchOutput(overrides: Record<string, unknown> = {}) {
  return {
    status: "success",
    query: "历史",
    scopeNote: "扫描 12 个会话",
    hits: [
      {
        sessionId: "sess_abc123",
        title: "重构 History 工具卡",
        segment: 12,
        role: "assistant",
        at: 1_700_000_100_000,
        snippet: "…为【历史】系列组件设计一个…",
      },
    ],
    truncated: false,
    ...overrides,
  };
}

function assertPersistable(display: NonNullable<ReturnType<typeof createToolResultDisplay>>) {
  const persisted = parseToolResultDisplayPayload(JSON.parse(JSON.stringify(display)));
  assert.deepEqual(persisted, display);

  const protocolOutput = toolOutputSchema.parse({ text: "模型文本投影", display });
  assert.deepEqual(protocolOutput.display, display);
}

test("HistoryList display 投影 scopeNote 与会话计数", () => {
  const display = createToolResultDisplay(HISTORY_LIST_TOOL_NAME, historyListOutput());

  assert.deepEqual(display, {
    kind: "history_list",
    status: "success",
    scopeNote: "最近 7 天 · 已隐藏子代理会话",
    sessionCount: 2,
  });
  assertPersistable(display!);
});

test("HistoryList display 空结果与空 scopeNote 都不进载荷", () => {
  const display = createToolResultDisplay(
    HISTORY_LIST_TOOL_NAME,
    historyListOutput({ scopeNote: "  ", sessions: [] }),
  );

  assert.deepEqual(display, {
    kind: "history_list",
    status: "success",
    sessionCount: 0,
  });
});

test("HistoryList display 业务失败状态原样携带", () => {
  const display = createToolResultDisplay(
    HISTORY_LIST_TOOL_NAME,
    historyListOutput({ status: "failed", scopeNote: "", sessions: [], error: "SessionStorePort is not configured" }),
  );

  assert.equal(display && "status" in display && display.status, "failed");
  assertPersistable(display!);
});

test("HistoryRead display 投影标题与会话 id（折叠行只回答读了哪个会话）", () => {
  const display = createToolResultDisplay(HISTORY_READ_TOOL_NAME, historyReadOutput());

  assert.deepEqual(display, {
    kind: "history_read",
    status: "success",
    title: "重构 History 工具卡",
    sessionId: "sess_abc123",
  });
  assertPersistable(display!);
});

test("HistoryRead display 无标题省略 title，段坐标不进载荷", () => {
  const display = createToolResultDisplay(
    HISTORY_READ_TOOL_NAME,
    historyReadOutput({ title: null, page: { start: 24_000, end: 48_000, nextOffset: 48_000, viaSegment: 12 } }),
  );

  assert.deepEqual(display, {
    kind: "history_read",
    status: "success",
    sessionId: "sess_abc123",
  });
});

test("HistoryRead display 超长标题截断并打 truncated", () => {
  const display = createToolResultDisplay(
    HISTORY_READ_TOOL_NAME,
    historyReadOutput({ title: "标".repeat(500) }),
  );

  assert.ok(display && "title" in display && display.title.length < 200);
  assert.equal(display && "truncated" in display, true);
  assertPersistable(display!);
});

test("HistoryRead display 空 sessionId 放弃载荷走文本兜底", () => {
  const display = createToolResultDisplay(
    HISTORY_READ_TOOL_NAME,
    historyReadOutput({ sessionId: "  " }),
  );

  assert.equal(display, undefined);
});

test("HistorySearch display 投影 query、命中数与截断标记", () => {
  const display = createToolResultDisplay(
    HISTORY_SEARCH_TOOL_NAME,
    historySearchOutput({ truncated: true }),
  );

  assert.deepEqual(display, {
    kind: "history_search",
    status: "success",
    query: "历史",
    hitCount: 1,
    truncated: true,
  });
  assertPersistable(display!);
});

test("HistorySearch display not_found 与无命中原样携带", () => {
  const display = createToolResultDisplay(
    HISTORY_SEARCH_TOOL_NAME,
    historySearchOutput({ status: "not_found", hits: [] }),
  );

  assert.deepEqual(display, {
    kind: "history_search",
    status: "not_found",
    query: "历史",
    hitCount: 0,
  });
});

test("HistorySearch display 超长 query 截断", () => {
  const display = createToolResultDisplay(
    HISTORY_SEARCH_TOOL_NAME,
    historySearchOutput({ query: "词".repeat(300) }),
  );

  assert.ok(display && display.kind === "history_search" && display.query.length < 200);
  assert.equal(display && "truncated" in display, true);
});

test("输出形态不符或无关工具名不生成 display", () => {
  assert.equal(createToolResultDisplay(HISTORY_LIST_TOOL_NAME, { unexpected: true }), undefined);
  assert.equal(createToolResultDisplay("UnrelatedTool", historyListOutput()), undefined);
});
