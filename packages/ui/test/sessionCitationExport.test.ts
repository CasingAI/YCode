import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConversationShareMarkdown } from "../src/v4/conversationShareMarkdown.js";
import { buildConversationFindIndex } from "../src/v4/conversationFindIndex.js";
import type { ConversationTurnRenderUnit } from "../src/v4/conversationTurnRenderUnits.js";

function assistantUnit(text: string, key = "u1"): ConversationTurnRenderUnit {
  return {
    key,
    unitIndex: 0,
    isRunning: false,
    visibleUserInputs: [],
    assistantTextRows: [{ kind: "assistantText", rowId: 1, text, state: "complete" }],
    latestAssistantTextRow: { kind: "assistantText", rowId: 1, text, state: "complete" },
  } as unknown as ConversationTurnRenderUnit;
}

test("分享：ycode 会话链接降级为纯链接文本，URL 不进公开文本", () => {
  const out = normalizeConversationShareMarkdown(
    "结论见：[鉴权结论](ycode://session/open?sessionId=sess_a&search=鉴权结论) 好",
  );
  // sessionId/URL 不应进公开文本，链接文本保留。
  assert.ok(!out.includes("sess_a"));
  assert.ok(!out.includes("ycode://"));
  assert.ok(out.includes("鉴权结论"));
  assert.ok(out.includes("结论见"));
});

test("分享：遗留指令块剥离成文本片段，语法原文永不进分享内容", () => {
  const out = normalizeConversationShareMarkdown(
    '见：:::zcode-session-citation{session=sess_a, text="原文", segment=2, title="鉴权结论"} 好',
  );
  assert.ok(!out.includes("zcode-session-citation"), `指令语法泄漏:\n${out}`);
  assert.ok(!out.includes("session="), `字段泄漏:\n${out}`);
  assert.ok(!out.includes("segment="), `字段泄漏:\n${out}`);
  assert.ok(!out.includes("title="), `字段泄漏:\n${out}`);
  assert.ok(!out.includes("sess_a"), `sessionId 泄漏:\n${out}`);
  assert.ok(out.includes("原文"), `text 文本丢失:\n${out}`);
  assert.ok(out.includes("好"));
});

test("分享：遗留指令无 text 时退 title，都没有整段丢弃", () => {
  const byTitle = normalizeConversationShareMarkdown(
    '见:::zcode-session-citation{session=sess_a, title="鉴权结论"} 好',
  );
  assert.ok(!byTitle.includes("zcode-session-citation"), `指令语法泄漏:\n${byTitle}`);
  assert.ok(byTitle.includes("鉴权结论"), `title 文本丢失:\n${byTitle}`);

  const dropped = normalizeConversationShareMarkdown(
    "见:::zcode-session-citation{session=sess_a} 好",
  );
  assert.ok(!dropped.includes("zcode-session-citation"), `指令语法泄漏:\n${dropped}`);
  assert.ok(!dropped.includes("session="), `字段泄漏:\n${dropped}`);
});

test("搜索索引：URL 不参与匹配，链接文本可搜到", () => {
  const units = [
    assistantUnit(
      "结论：[鉴权结论](ycode://session/open?sessionId=sess_abc123&search=鉴权结论) 好",
    ),
  ];
  // 搜 sessionId 命中数为 0。
  const bySession = buildConversationFindIndex(units, "sess_abc123");
  assert.equal(bySession.matchCount, 0);
  // 搜 scheme 命中数为 0。
  const byScheme = buildConversationFindIndex(units, "ycode");
  assert.equal(byScheme.matchCount, 0);
  // 搜链接文本能命中。
  const byTitle = buildConversationFindIndex(units, "鉴权结论");
  assert.equal(byTitle.matchCount, 1);
  // 搜正文其余内容能命中。
  const byBody = buildConversationFindIndex(units, "结论");
  assert.ok(byBody.matchCount >= 1);
});

test("搜索索引：遗留指令语法不参与匹配，文本片段可搜到", () => {
  const units = [
    assistantUnit('结论：:::zcode-session-citation{session=sess_a, text="鉴权原文", segment=2} 好'),
  ];
  // 搜指令名/字段名/sessionId 命中数为 0。
  assert.equal(buildConversationFindIndex(units, "zcode-session-citation").matchCount, 0);
  assert.equal(buildConversationFindIndex(units, "session=").matchCount, 0);
  assert.equal(buildConversationFindIndex(units, "sess_a").matchCount, 0);
  // 搜剥离后的文本片段能命中。
  assert.equal(buildConversationFindIndex(units, "鉴权原文").matchCount, 1);
  // 搜正文其余内容能命中。
  assert.ok(buildConversationFindIndex(units, "结论").matchCount >= 1);
});
