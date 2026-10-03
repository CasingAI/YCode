import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConversationQueryDirectoryEntries,
  v4ConversationQueryDirectoryParamsSchema,
  v4ConversationQueryDirectoryResultSchema,
  v4ConversationRowsRangeParamsSchema,
  v4ConversationRowsRangeResultSchema,
  PROTOCOL_V4_LIMITS,
} from "../src/zcode-protocol-v4/index.js";

function unit(overrides: Record<string, unknown> = {}) {
  return {
    key: "turn:1",
    turnId: "turn:1",
    userInputs: [
      { rowId: 10, entityId: "input:10", text: "  第一问\n\n第二段  细节  ", origin: "realUser" },
    ],
    assistantTexts: ["助手答复第一段。\n\n助手答复第二段。"],
    isRunning: false,
    timelineOnly: false,
    ...overrides,
  };
}

test("目录骨架只收 realUser 系统来源不得入目录", () => {
  const entries = buildConversationQueryDirectoryEntries([
    unit({
      userInputs: [
        { rowId: 1, text: "background 结果", origin: "backgroundResult" },
        { rowId: 2, text: "goal 续写", origin: "goalContinuation" },
        { rowId: 3, text: "mailbox", origin: "mailbox" },
      ],
    }),
    unit({ key: "turn:2", turnId: "turn:2", timelineOnly: true }),
  ]);

  assert.equal(entries.length, 0);
});

test("同 turn 多条 steer query 逐条建项 key 用稳定 row 身份", () => {
  const entries = buildConversationQueryDirectoryEntries([
    unit({
      userInputs: [
        { rowId: 10, entityId: "input:10", text: "第一条", origin: "realUser" },
        { rowId: 11, text: "第二条", origin: "realUser" },
      ],
    }),
  ]);

  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.key, "turn:1:query:input:10");
  assert.equal(entries[1]?.key, "turn:1:query:11");
});

test("摘要截断与 running 归属只属于最后一条 query", () => {
  const entries = buildConversationQueryDirectoryEntries([
    unit({
      userInputs: [
        { rowId: 10, text: "旧 query", origin: "realUser" },
        { rowId: 11, text: "新 query", origin: "realUser" },
      ],
      assistantTexts: [],
      isRunning: true,
    }),
  ]);

  assert.equal(entries.length, 2);
  // 同一 running turn 只有最后一条 query 标 running。
  assert.equal(entries[0]?.assistantPreviewKind, "empty");
  assert.equal(entries[1]?.assistantPreviewKind, "running");
});

test("正文聚合截断到 220 字助手空时 kind 为 empty", () => {
  const entries = buildConversationQueryDirectoryEntries([
    unit({
      assistantTexts: ["x".repeat(300)],
    }),
    unit({ key: "turn:2", turnId: "turn:2", assistantTexts: [] }),
  ]);

  assert.equal(entries[0]?.assistantPreview.length, 220);
  assert.ok(entries[0]?.assistantPreview.endsWith("..."));
  assert.equal(entries[0]?.assistantPreviewKind, "text");
  assert.equal(entries[1]?.assistantPreviewKind, "empty");
  // 空摘要由 UI 按 kind 做本地化兜底，协议层只传空串。
  assert.equal(entries[1]?.assistantPreview, "");
});

test("queryDirectory schema 严格且 afterRowId 可分页", () => {
  assert.equal(
    v4ConversationQueryDirectoryParamsSchema.safeParse({ sessionId: "s", limit: 50 }).success,
    true,
  );
  assert.equal(
    v4ConversationQueryDirectoryParamsSchema.safeParse({
      sessionId: "s",
      afterRowId: 10,
      limit: PROTOCOL_V4_LIMITS.queryDirectoryMaxEntries + 1,
    }).success,
    false,
  );
  // 宽松 limit（60 行 tail 兼容）仍可通过：旧客户端发大 limit 时 CLI 按上限截断而非拒绝。
  const result = v4ConversationQueryDirectoryResultSchema.parse({
    entries: [],
    hasMore: false,
    atSeq: 1,
    atRevision: 0,
    atLogEpoch: "epoch",
  });
  assert.equal(result.hasMore, false);
});

test("queryDirectory params 收下 host 注入的 clientMode（strict schema 的接缝回归）", () => {
  // zcodeAgentService 与 rows/range 同构地把可信 clientMode 塞进 params。本 schema 是
  // strict 的，一旦漏收该字段，网关 parse 抛错 → 目录恒空 → rail 因 items.length < 2
  // 永不渲染，且生产构建下 renderer 日志是 no-op，故障完全静默。这条用例钉住接缝形状：
  // renderer 省略它、host 注入它，两者都必须解析成功。
  const fromRenderer = v4ConversationQueryDirectoryParamsSchema.safeParse({
    sessionId: "s",
    limit: 50,
  });
  assert.equal(fromRenderer.success, true);

  for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
    const injected = v4ConversationQueryDirectoryParamsSchema.safeParse({
      sessionId: "s",
      clientMode,
      limit: 50,
    });
    assert.equal(injected.success, true, `clientMode=${clientMode} 必须被 strict schema 收下`);
    assert.equal(injected.success && injected.data.clientMode, clientMode);
  }

  // 未知字段仍然拒绝：strict 的本意是挡住真正的偏斜，不是因为要收 clientMode 就放开。
  assert.equal(
    v4ConversationQueryDirectoryParamsSchema.safeParse({
      sessionId: "s",
      clientMode: "desktop-continuous",
      bogus: 1,
      limit: 50,
    }).success,
    false,
  );
});

test("rowsRange 新方向参数互斥语义由 CLI 裁决 schema 只做可选", () => {
  // 缺省 = 从尾部向前；around/after 由调用方按场景二选一。
  const base = v4ConversationRowsRangeParamsSchema.parse({ sessionId: "s", limit: 60 });
  assert.equal(base.beforeRowId, undefined);
  assert.equal(base.afterRowId, undefined);
  assert.equal(base.aroundRowId, undefined);
  const around = v4ConversationRowsRangeParamsSchema.parse({
    sessionId: "s",
    aroundRowId: 100,
    limit: 60,
  });
  assert.equal(around.aroundRowId, 100);
  // 老结果无 hasMoreNewer 时按等价缺省处理，不破坏旧客户端。
  const legacy = v4ConversationRowsRangeResultSchema.parse({
    rows: [],
    atSeq: 1,
    atRevision: 0,
    atLogEpoch: "epoch",
    hasMore: false,
  });
  assert.equal(legacy.hasMoreNewer, undefined);
});
