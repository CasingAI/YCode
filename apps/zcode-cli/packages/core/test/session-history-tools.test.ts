import assert from "node:assert/strict";
import test from "node:test";
import {
  HISTORY_LIST_TOOL_NAME,
  HISTORY_READ_TOOL_NAME,
  HISTORY_SEARCH_TOOL_NAME,
  HistoryListOutputSchema,
  HistoryReadOutputSchema,
  HistorySearchOutputSchema,
  type MessageWithParts,
  type MessageSemantics,
  type SessionId,
  type SessionInfo,
  type SessionStorePort,
  type ToolExecutionContext,
  type UserMessageInfo,
  type AssistantMessageInfo,
} from "@zcode/contracts";
import { ToolRegistryImpl } from "../src/tool/registry.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { historyListToolEntry } from "../src/tool/handlers/history-list.js";
import { historyReadToolEntry } from "../src/tool/handlers/history-read.js";
import { historySearchToolEntry } from "../src/tool/handlers/history-search.js";
import {
  AI_HISTORY_SEARCH_SESSION_ID_PREFIX,
  buildTurns,
  isHiddenHistorySession,
  makeSnippet,
  parseHistoryKeywords,
  renderTurnsPage,
  wantMessage,
} from "../src/session-history/session-history.js";

const DAY_MS = 86_400_000;

// -----------------------------------------------
// 测试数据构造
// -----------------------------------------------

let seq = 0;

function userTurn(
  text: string,
  opts: {
    origin?: "real_user" | "system";
    kind?: MessageSemantics["kind"];
    visibility?: "visible" | "hidden";
    at?: number;
  } = {},
): MessageWithParts {
  const id = `msg_u${++seq}`;
  return {
    info: {
      id,
      sessionID: "sess_test" as SessionId,
      role: "user",
      time: { created: opts.at ?? 1_700_000_000_000 },
      semantics: {
        origin: opts.origin ?? "real_user",
        kind: opts.kind ?? "user_prompt",
        uiVisibility: "visible",
        providerVisibility: "visible",
        transcriptVisibility: opts.visibility ?? "visible",
      },
    } as UserMessageInfo,
    parts: [{ id: `part_${id}`, sessionID: "sess_test" as SessionId, messageID: id, type: "text", text }],
  };
}

function assistantTurn(text: string, at = 1_700_000_000_000): MessageWithParts {
  const id = `msg_a${++seq}`;
  return {
    info: {
      id,
      sessionID: "sess_test" as SessionId,
      role: "assistant",
      time: { created: at },
      semantics: {
        origin: "agent_runtime",
        kind: "assistant_response",
        uiVisibility: "visible",
        providerVisibility: "visible",
        transcriptVisibility: "visible",
      },
    } as AssistantMessageInfo,
    parts: [{ id: `part_${id}`, sessionID: "sess_test" as SessionId, messageID: id, type: "text", text }],
  };
}

function sessionInfo(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: id as SessionId,
    projectID: "proj_test",
    taskType: "interactive",
    slug: id,
    directory: "/tmp/proj",
    title: "",
    version: "test",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
    ...overrides,
  } as SessionInfo;
}

function stubStore(
  sessions: SessionInfo[],
  messagesBySession: Record<string, MessageWithParts[]>,
  counts?: Record<string, number>,
): SessionStorePort {
  return {
    listSessions: async () => sessions,
    getSession: async (sessionID: SessionId) => sessions.find((s) => s.id === sessionID) ?? null,
    messages: async ({ sessionID }: { sessionID: SessionId }) => messagesBySession[sessionID] ?? [],
    ...(counts
      ? {
          sessionMessageCounts: async ({ sessionIDs }: { sessionIDs: SessionId[] }) =>
            Object.fromEntries(sessionIDs.filter((id) => id in counts).map((id) => [id, counts[id]])),
        }
      : {}),
  } as unknown as SessionStorePort;
}

function fakeContext(store: SessionStorePort | undefined): ToolExecutionContext {
  return {
    sessionStore: store,
    toolCallId: "call_1",
    abortSignal: new AbortController().signal,
    sessionId: "sess_current",
  } as unknown as ToolExecutionContext;
}

// -----------------------------------------------
// 注册与元数据
// -----------------------------------------------

test("三个 History 工具 always-on 注册，只读免审批", () => {
  const registry = new ToolRegistryImpl();
  registerBuiltInTools(registry);
  for (const name of [HISTORY_LIST_TOOL_NAME, HISTORY_READ_TOOL_NAME, HISTORY_SEARCH_TOOL_NAME]) {
    const metadata = registry.getMetadata(name);
    assert.ok(metadata, `${name} 应注册`);
    assert.equal(metadata.readOnly, true);
    assert.equal(metadata.needsApproval, false);
  }
});

test("三个 entry 的权限与预算同档（session.history.read / low / 免审批）", () => {
  for (const entry of [historyListToolEntry, historyReadToolEntry, historySearchToolEntry]) {
    assert.equal(entry.permission?.permission, "session.history.read");
    assert.equal(entry.permission?.needsApproval, false);
    assert.equal(entry.metadata.riskLevel, "low");
    assert.equal(entry.metadata.readOnly, true);
  }
});

// -----------------------------------------------
// wantMessage / buildTurns
// -----------------------------------------------

test("wantMessage 过滤矩阵：role、timeline 事件、隐藏正文、非真实用户", () => {
  const realUser = userTurn("我说的话").info;
  const systemUser = userTurn("hook 注入", { origin: "system" }).info;
  const timeline = userTurn("模型切换", { kind: "timeline_event" }).info;
  const hidden = userTurn("系统提醒", { visibility: "hidden" }).info;
  const assistant = assistantTurn("模型回答").info;

  for (const role of ["assistant", "user", "both"] as const) {
    assert.equal(wantMessage(systemUser, role), false, `origin=system 的 user 消息在 role=${role} 下都不可见`);
    assert.equal(wantMessage(timeline, role), false, `timeline_event 在 role=${role} 下都不可见`);
    assert.equal(wantMessage(hidden, role), false, `transcriptVisibility=hidden 在 role=${role} 下都不可见`);
  }
  assert.equal(wantMessage(realUser, "user"), true);
  assert.equal(wantMessage(realUser, "both"), true);
  assert.equal(wantMessage(realUser, "assistant"), false);
  assert.equal(wantMessage(assistant, "assistant"), true);
  assert.equal(wantMessage(assistant, "both"), true);
  assert.equal(wantMessage(assistant, "user"), false);
});

test("buildTurns：同消息多 text part 用 \\n 拼接，空文本与非 text part 剔除", () => {
  const multi = userTurn("第一段");
  multi.parts.push({
    id: "part_extra",
    sessionID: "sess_test" as SessionId,
    messageID: multi.info.id,
    type: "text",
    text: "第二段",
  });
  const withNoise = assistantTurn("  ");
  withNoise.parts.push({
    id: "part_tool",
    sessionID: "sess_test" as SessionId,
    messageID: withNoise.info.id,
    type: "tool",
    callID: "call_x",
    tool: "Read",
    state: { status: "completed", input: {}, output: "工具输出不进存档", title: "Read", metadata: {}, time: { start: 1, end: 2 } },
  } as never);

  const turns = buildTurns([multi, withNoise], "both");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, "第一段\n第二段");
});

// -----------------------------------------------
// 段号坐标系与分页
// -----------------------------------------------

function threeTurns(): MessageWithParts[] {
  return [
    userTurn("first 用户问题", { at: 1_700_000_000_000 }),
    assistantTurn("second 模型回答 alpha", 1_700_000_000_001),
    userTurn("third 追问 beta", { at: 1_700_000_000_002 }),
  ];
}

test("坐标系一致性：search 命中段 N ≡ read(role=both, fromSegment=N) 的起始段", () => {
  const turns = buildTurns(threeTurns(), "both");
  const keywords = parseHistoryKeywords("alpha");
  const hitIndex = turns.findIndex((turn) => keywords.every((k) => turn.text.toLowerCase().includes(k)));
  const hitSegment = hitIndex + 1;

  const page = renderTurnsPage(turns, { offset: 0, maxChars: 0, fromSegment: hitSegment });
  assert.equal(page.viaSegment, hitSegment);
  assert.ok(page.content.startsWith(`[${hitSegment}]`), "fromSegment 落地页必须从命中段的开头开始");
  assert.ok(page.content.includes("alpha"));
});

test("renderTurnsPage：默认截断给 nextOffset，maxChars=0 全量，offset 越界有明确文案", () => {
  const turns = buildTurns(threeTurns(), "both");

  const paged = renderTurnsPage(turns, { offset: 0, maxChars: 10, fromSegment: null });
  assert.equal(paged.content.length, 10);
  assert.equal(paged.nextOffset, 10);
  assert.equal(paged.startOffset, 0);
  assert.equal(paged.endOffset, 10);

  const full = renderTurnsPage(turns, { offset: 0, maxChars: 0, fromSegment: null });
  assert.equal(full.totalSegments, 3);
  assert.equal(full.endOffset, full.totalChars);
  assert.equal(full.nextOffset, null);

  const beyond = renderTurnsPage(turns, { offset: full.totalChars + 100, maxChars: 10, fromSegment: null });
  assert.ok(beyond.content.includes("没有更多内容"));
  assert.equal(beyond.nextOffset, null);
});

test("renderTurnsPage：fromSegment 优先于 offset", () => {
  const turns = buildTurns(threeTurns(), "both");
  const viaOffset = renderTurnsPage(turns, { offset: 0, maxChars: 0, fromSegment: 2 });
  assert.equal(viaOffset.viaSegment, 2);
  assert.ok(viaOffset.content.startsWith("[2]"));
});

test("makeSnippet：压平换行并高亮关键词", () => {
  const snippet = makeSnippet("前文\n关键词命中\n后文", ["关键词"]);
  assert.ok(!snippet.includes("\n"));
  assert.ok(snippet.includes("【关键词】"));
  assert.equal(parseHistoryKeywords("  Alpha beta  ALPHA  ").join("|"), "alpha|beta");
});

// -----------------------------------------------
// HistoryList handler
// -----------------------------------------------

test("HistoryList：days / 子代理前缀 / workspace 子串 / limit 过滤", async () => {
  const now = Date.now();
  const sessions = [
    sessionInfo("sess_recent", { title: "YCode 修复", time: { created: now, updated: now - 2 * DAY_MS } }),
    sessionInfo("sess_old", { title: "旧会话", time: { created: now, updated: now - 30 * DAY_MS } }),
    sessionInfo("sess_subagent_1", { title: "子代理", time: { created: now, updated: now - 1 * DAY_MS } }),
    sessionInfo("sess_other_dir", { directory: "/home/user/other", time: { created: now, updated: now - 3 * DAY_MS } }),
    sessionInfo("sess_fifth", { title: "第五个", time: { created: now, updated: now - 4 * DAY_MS } }),
  ];
  const output = HistoryListOutputSchema.parse(
    await historyListToolEntry.handler(
      { workspace: "ycode", limit: 2 },
      fakeContext(stubStore(sessions, {})),
    ),
  );
  assert.equal(output.status, "success");
  assert.deepEqual(output.sessions.map((s) => s.sessionId), ["sess_recent"]);
});

test("HistoryList：withSubagents=true 纳入子代理会话", async () => {
  const now = Date.now();
  const sessions = [
    sessionInfo("sess_main", { time: { created: now, updated: now - DAY_MS } }),
    sessionInfo("sess_subagent_1", { time: { created: now, updated: now - DAY_MS } }),
  ];
  const output = HistoryListOutputSchema.parse(
    await historyListToolEntry.handler({ withSubagents: true }, fakeContext(stubStore(sessions, {}))),
  );
  assert.equal(output.sessions.length, 2);
});

test("HistoryList：默认隐藏 AI 历史搜索一次性会话，withSubagents=true 纳入", async () => {
  const now = Date.now();
  const sessions = [
    sessionInfo("sess_main", { time: { created: now, updated: now - DAY_MS } }),
    sessionInfo(`${AI_HISTORY_SEARCH_SESSION_ID_PREFIX}abc`, {
      taskType: "ai_history_search",
      time: { created: now, updated: now - DAY_MS },
    }),
    // 仅 taskType 命中也应隐藏（id 前缀双重判定兜底）。
    sessionInfo("sess_plain_id", {
      taskType: "ai_history_search",
      time: { created: now, updated: now - DAY_MS },
    }),
  ];
  const hidden = HistoryListOutputSchema.parse(
    await historyListToolEntry.handler({}, fakeContext(stubStore(sessions, {}))),
  );
  assert.deepEqual(hidden.sessions.map((s) => s.sessionId), ["sess_main"]);

  const shown = HistoryListOutputSchema.parse(
    await historyListToolEntry.handler({ withSubagents: true }, fakeContext(stubStore(sessions, {}))),
  );
  assert.equal(shown.sessions.length, 3);
});

test("isHiddenHistorySession：子代理与 AI 搜索会话默认隐藏", () => {
  assert.equal(isHiddenHistorySession({ id: "sess_main" }, false), false);
  assert.equal(isHiddenHistorySession({ id: "sess_subagent_1" }, false), true);
  assert.equal(
    isHiddenHistorySession({ id: `${AI_HISTORY_SEARCH_SESSION_ID_PREFIX}abc` }, false),
    true,
  );
  assert.equal(isHiddenHistorySession({ id: "sess_x", taskType: "ai_history_search" }, false), true);
  assert.equal(isHiddenHistorySession({ id: "sess_subagent_1" }, true), false);
  assert.equal(
    isHiddenHistorySession({ id: `${AI_HISTORY_SEARCH_SESSION_ID_PREFIX}abc` }, true),
    false,
  );
});

test("HistoryList：messageCounts 在场补列、缺席降级省略", async () => {
  const now = Date.now();
  const sessions = [sessionInfo("sess_a", { time: { created: now, updated: now } })];
  const withCounts = HistoryListOutputSchema.parse(
    await historyListToolEntry.handler({}, fakeContext(stubStore(sessions, {}, { sess_a: 7 }))),
  );
  assert.equal(withCounts.sessions[0].messageCount, 7);

  const withoutCounts = HistoryListOutputSchema.parse(
    await historyListToolEntry.handler({}, fakeContext(stubStore(sessions, {}))),
  );
  assert.equal(withoutCounts.sessions[0].messageCount, undefined);
});

test("HistoryList：归档会话也在扫描范围（includeArchived）", async () => {
  const now = Date.now();
  let seenIncludeArchived: boolean | undefined;
  const store = {
    listSessions: async (input: { includeArchived?: boolean }) => {
      seenIncludeArchived = input.includeArchived;
      return [];
    },
  } as unknown as SessionStorePort;
  await historyListToolEntry.handler({}, fakeContext(store));
  assert.equal(seenIncludeArchived, true);
});

// -----------------------------------------------
// HistoryRead handler
// -----------------------------------------------

test("HistoryRead：not_found / 端口缺席 ConfigurationError", async () => {
  const output = HistoryReadOutputSchema.parse(
    await historyReadToolEntry.handler(
      { sessionId: "sess_missing" },
      fakeContext(stubStore([], {})),
    ),
  );
  assert.equal(output.status, "not_found");

  await assert.rejects(
    () => historyReadToolEntry.handler({ sessionId: "sess_x" }, fakeContext(undefined)),
    /SessionStorePort is not configured/u,
  );
});

test("HistoryRead：默认 role=both，结构化分页字段与正文一致", async () => {
  const messages = [
    userTurn("用户的问题", { at: 1_700_000_000_000 }),
    assistantTurn("模型的回答", 1_700_000_000_001),
  ];
  const output = HistoryReadOutputSchema.parse(
    await historyReadToolEntry.handler(
      { sessionId: "sess_full" },
      fakeContext(stubStore([sessionInfo("sess_full", { title: "完整会话" })], { sess_full: messages })),
    ),
  );
  assert.equal(output.status, "success");
  assert.equal(output.role, "both");
  assert.equal(output.title, "完整会话");
  assert.equal(output.totalSegments, 2);
  assert.ok(output.content.includes("模型的回答"));
  assert.ok(output.content.includes("用户的问题"));
  assert.equal(output.page.nextOffset, null);
});

test("HistoryRead：省略 sessionId 时读 context.sessionId 会话", async () => {
  const messages = [
    userTurn("本会话的问题", { at: 1_700_000_000_000 }),
    assistantTurn("本会话的回答", 1_700_000_000_001),
  ];
  const output = HistoryReadOutputSchema.parse(
    await historyReadToolEntry.handler(
      {},
      fakeContext(stubStore([sessionInfo("sess_current", { title: "当前会话" })], { sess_current: messages })),
    ),
  );
  assert.equal(output.status, "success");
  assert.equal(output.sessionId, "sess_current");
  assert.equal(output.role, "both");
  assert.equal(output.totalSegments, 2);
  assert.ok(output.content.includes("本会话的问题"));
  assert.ok(output.content.includes("本会话的回答"));
});

test("HistoryRead：显式 role=assistant 仍只返回模型话", async () => {
  const messages = [
    userTurn("用户的问题", { at: 1_700_000_000_000 }),
    assistantTurn("模型的回答", 1_700_000_000_001),
  ];
  const output = HistoryReadOutputSchema.parse(
    await historyReadToolEntry.handler(
      { sessionId: "sess_full", role: "assistant" },
      fakeContext(stubStore([sessionInfo("sess_full")], { sess_full: messages })),
    ),
  );
  assert.equal(output.status, "success");
  assert.equal(output.role, "assistant");
  assert.equal(output.totalSegments, 1);
  assert.ok(output.content.includes("模型的回答"));
  assert.ok(!output.content.includes("用户的问题"));
});

test("HistoryRead：from_segment 越界返回 failed 且带范围文案", async () => {
  const output = HistoryReadOutputSchema.parse(
    await historyReadToolEntry.handler(
      { sessionId: "sess_full", role: "both", fromSegment: 9 },
      fakeContext(stubStore([sessionInfo("sess_full")], { sess_full: threeTurns() })),
    ),
  );
  assert.equal(output.status, "failed");
  assert.ok(output.error?.includes("超出范围"));
  assert.ok(output.error?.includes("共 3 段"));
});

test("HistoryRead：无正文会话 success 且 0 段（formatter 给提示）", async () => {
  const output = HistoryReadOutputSchema.parse(
    await historyReadToolEntry.handler(
      { sessionId: "sess_empty" },
      fakeContext(stubStore([sessionInfo("sess_empty")], { sess_empty: [] })),
    ),
  );
  assert.equal(output.status, "success");
  assert.equal(output.totalSegments, 0);
  const text = historyReadToolEntry.formatModelContent?.(output) ?? "";
  assert.ok(text.includes("没有符合条件的正文"));
});

test("HistoryRead：formatter 输出续读提示与标题", () => {
  const text = historyReadToolEntry.formatModelContent?.({
    status: "success",
    sessionId: "sess_full",
    role: "both",
    title: "某会话",
    totalSegments: 3,
    totalChars: 1000,
    page: { start: 0, end: 10, nextOffset: 10, viaSegment: null },
    content: "[1] 11-14 10:00 user\nhello",
  });
  assert.ok(text?.includes("《某会话》"));
  assert.ok(text?.includes("续读传 offset=10"));
  assert.ok(text?.includes("含上下文压缩之前的全部原文"));
});

// -----------------------------------------------
// HistorySearch handler
// -----------------------------------------------

test("HistorySearch：段号按 both 口径编号，role=user 命中不改编号", async () => {
  const messages = threeTurns(); // 段1=user、段2=assistant、段3=user
  const now = Date.now();
  const store = stubStore(
    [sessionInfo("sess_search", { title: "搜索会话", time: { created: now, updated: now } })],
    { sess_search: messages },
  );

  const bothHits = HistorySearchOutputSchema.parse(
    await historySearchToolEntry.handler({ query: "alpha" }, fakeContext(store)),
  );
  assert.equal(bothHits.status, "success");
  assert.equal(bothHits.hits.length, 1);
  assert.equal(bothHits.hits[0].segment, 2);
  assert.ok(bothHits.hits[0].snippet.includes("【alpha】"));

  const userHits = HistorySearchOutputSchema.parse(
    await historySearchToolEntry.handler({ query: "beta", role: "user" }, fakeContext(store)),
  );
  assert.equal(userHits.hits.length, 1);
  assert.equal(userHits.hits[0].segment, 3, "role 过滤只影响命中，不影响段号");
  assert.equal(userHits.hits[0].role, "user");
});

test("HistorySearch：多关键词 AND、子代理默认排除、withSubagents 纳入", async () => {
  const now = Date.now();
  const sessions = [
    sessionInfo("sess_main", { time: { created: now, updated: now } }),
    sessionInfo("sess_subagent_1", { time: { created: now, updated: now } }),
  ];
  const messagesBySession = {
    sess_main: [assistantTurn("讨论 root cause 与修复方案")],
    sess_subagent_1: [assistantTurn("root cause 分析子任务")],
  };
  const store = stubStore(sessions, messagesBySession);

  const andMissing = HistorySearchOutputSchema.parse(
    await historySearchToolEntry.handler({ query: "root cause 修复杂项" }, fakeContext(store)),
  );
  assert.equal(andMissing.hits.length, 0);

  const defaultScope = HistorySearchOutputSchema.parse(
    await historySearchToolEntry.handler({ query: "root cause" }, fakeContext(store)),
  );
  assert.deepEqual(defaultScope.hits.map((h) => h.sessionId), ["sess_main"]);

  const withSub = HistorySearchOutputSchema.parse(
    await historySearchToolEntry.handler({ query: "root cause", withSubagents: true }, fakeContext(store)),
  );
  assert.deepEqual(withSub.hits.map((h) => h.sessionId), ["sess_main", "sess_subagent_1"]);
});

test("HistorySearch：默认排除 AI 历史搜索一次性会话", async () => {
  const now = Date.now();
  const searchSessionId = `${AI_HISTORY_SEARCH_SESSION_ID_PREFIX}abc`;
  const sessions = [
    sessionInfo("sess_main", { time: { created: now, updated: now } }),
    sessionInfo(searchSessionId, {
      taskType: "ai_history_search",
      time: { created: now, updated: now },
    }),
  ];
  const messagesBySession = {
    sess_main: [assistantTurn("讨论 root cause 与修复方案")],
    [searchSessionId]: [assistantTurn("root cause 搜索过程自己的记录")],
  };
  const store = stubStore(sessions, messagesBySession);

  const defaultScope = HistorySearchOutputSchema.parse(
    await historySearchToolEntry.handler({ query: "root cause" }, fakeContext(store)),
  );
  assert.deepEqual(defaultScope.hits.map((h) => h.sessionId), ["sess_main"]);
});

test("HistorySearch：指定会话不存在 → not_found；限定会话内搜索不套时间窗", async () => {
  const old = Date.now() - 90 * DAY_MS;
  const messages = [assistantTurn("很久以前的 root cause 记录", old)];
  const store = stubStore(
    [sessionInfo("sess_archive", { time: { created: old, updated: old } })],
    { sess_archive: messages },
  );

  const scoped = HistorySearchOutputSchema.parse(
    await historySearchToolEntry.handler(
      { query: "root cause", sessionId: "sess_archive" },
      fakeContext(store),
    ),
  );
  assert.equal(scoped.status, "success");
  assert.equal(scoped.hits.length, 1, "session 限定不受默认 days=14 时间窗影响");

  const missing = HistorySearchOutputSchema.parse(
    await historySearchToolEntry.handler(
      { query: "root cause", sessionId: "sess_missing" },
      fakeContext(store),
    ),
  );
  assert.equal(missing.status, "not_found");
});

test("HistorySearch：达到 limit 标记 truncated", async () => {
  const now = Date.now();
  const messages = [
    assistantTurn("root cause 一", 1),
    assistantTurn("root cause 二", 2),
    assistantTurn("root cause 三", 3),
  ];
  const output = HistorySearchOutputSchema.parse(
    await historySearchToolEntry.handler(
      { query: "root cause", limit: 2 },
      fakeContext(stubStore([sessionInfo("sess_many", { time: { created: now, updated: now } })], { sess_many: messages })),
    ),
  );
  assert.equal(output.hits.length, 2);
  assert.equal(output.truncated, true);
});

test("HistorySearch：scopeNote 报告实际扫描会话数与更新时间跨度，而非时间窗", async () => {
  const now = Date.now();
  const newer = now - 1 * DAY_MS;
  const older = now - 5 * DAY_MS;
  // 与 formatDaySpan 同口径的本地 MM-DD（跨年补年份），保证断言不随运行日期漂移。
  const fmt = (ms: number) => {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    const monthDay = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return d.getFullYear() === new Date().getFullYear() ? monthDay : `${d.getFullYear()}-${monthDay}`;
  };
  const store = stubStore(
    [
      sessionInfo("sess_new", { time: { created: now, updated: newer } }),
      sessionInfo("sess_old", { time: { created: older, updated: older } }),
    ],
    {
      sess_new: [assistantTurn("root cause 记录")],
      sess_old: [assistantTurn("root cause 记录")],
    },
  );

  const output = HistorySearchOutputSchema.parse(
    await historySearchToolEntry.handler({ query: "root cause" }, fakeContext(store)),
  );
  assert.equal(output.hits.length, 2);
  assert.equal(output.scopeNote, `2 个会话 · 更新于 ${fmt(older)} ~ ${fmt(newer)}`);
});

test("HistorySearch：命中上限提前截断时，scopeNote 只覆盖已扫描会话", async () => {
  const now = Date.now();
  const store = stubStore(
    [
      sessionInfo("sess_new", { time: { created: now, updated: now - 1 * DAY_MS } }),
      sessionInfo("sess_old", { time: { created: now, updated: now - 2 * DAY_MS } }),
    ],
    {
      sess_new: [assistantTurn("root cause 一"), assistantTurn("root cause 二")],
      sess_old: [assistantTurn("root cause 三")],
    },
  );

  const output = HistorySearchOutputSchema.parse(
    await historySearchToolEntry.handler({ query: "root cause", limit: 2 }, fakeContext(store)),
  );
  assert.equal(output.truncated, true);
  const scannedDay = new Date(now - 1 * DAY_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  const scannedDayText = `${pad(scannedDay.getMonth() + 1)}-${pad(scannedDay.getDate())}`;
  assert.equal(output.scopeNote, `1/2 个会话 · 更新于 ${scannedDayText}`);
});

test("HistorySearch：候选为空时 scopeNote 回退报告时间窗", async () => {
  const output = HistorySearchOutputSchema.parse(
    await historySearchToolEntry.handler({ query: "root cause" }, fakeContext(stubStore([], {}))),
  );
  assert.equal(output.hits.length, 0);
  assert.equal(output.scopeNote, "最近 14 天 · 0 个会话");
});

test("HistorySearch display：结构化引用按命中顺序取前 N 条并独立限长", async () => {
  const { createHistoryDisplay } = await import("../src/tool/executor/history-display.js");
  const output = HistorySearchOutputSchema.parse(
    await historySearchToolEntry.handler({ query: "root cause" }, fakeContext(stubStore(
      [sessionInfo("sess_main", { title: "主会话", time: { created: Date.now(), updated: Date.now() } })],
      { sess_main: [assistantTurn("讨论 root cause 与修复方案")] },
    ))),
  );
  const display = createHistoryDisplay("HistorySearch", output);
  assert.ok(display && display.kind === "history_search");
  assert.equal(display.hitCount, 1);
  assert.ok(Array.isArray(display.citations) && display.citations.length === 1);
  assert.equal(display.citations[0]?.sessionId, "sess_main");
  assert.equal(display.citations[0]?.segment, 1);
  // 摘录带【】关键词高亮（makeSnippet 版式），含 root 与 cause 即正确。
  assert.ok(display.citations[0]?.snippet.includes("root"));
  assert.ok(display.citations[0]?.snippet.includes("cause"));
  // at 透传命中消息时间（assistantTurn 默认时间戳）。
  assert.equal(display.citations[0]?.at, 1700000000000);
});

test("HistorySearch display：无命中时 citations 字段缺席", async () => {
  const { createHistoryDisplay } = await import("../src/tool/executor/history-display.js");
  const display = createHistoryDisplay("HistorySearch", {
    status: "success",
    query: "nothing",
    scopeNote: "",
    hits: [],
    truncated: false,
  });
  assert.ok(display && display.kind === "history_search");
  assert.equal(display.citations, undefined);
});
