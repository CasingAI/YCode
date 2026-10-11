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

test("分享：会话引用指令被剥离，title 保留", () => {
  const out = normalizeConversationShareMarkdown(
    '结论见：:::zcode-session-citation{session=sess_a, text="原文", title="鉴权结论"} 好',
  );
  // 指令原文（sessionId/参数语法）不应进公开文本，标题保留。
  assert.ok(!out.includes("sess_a"));
  assert.ok(!out.includes("zcode-session-citation"));
  assert.ok(out.includes("鉴权结论"));
  assert.ok(out.includes("结论见"));
});

test("分享：无 title 的引用整段置空，代码块内不受影响", () => {
  const out = normalizeConversationShareMarkdown(
    '见：:::zcode-session-citation{session=sess_a, text="原文"} 好',
  );
  assert.ok(!out.includes("sess_a"));
  assert.ok(!out.includes("zcode-session-citation"));
  assert.ok(out.includes("好"));

  const code = normalizeConversationShareMarkdown(
    "```\n:::zcode-session-citation{session=sess_a}\n```",
  );
  assert.ok(code.includes("sess_a"));
});

test("搜索索引：指令原文不参与匹配，title 可搜到", () => {
  const units = [
    assistantUnit(
      '结论：:::zcode-session-citation{session=sess_abc123, text="原文", title="鉴权结论"} 好',
    ),
  ];
  // 搜 sessionId 命中数为 0。
  const bySession = buildConversationFindIndex(units, "sess_abc123");
  assert.equal(bySession.matchCount, 0);
  // 搜指令名命中数为 0。
  const byDirective = buildConversationFindIndex(units, "zcode-session-citation");
  assert.equal(byDirective.matchCount, 0);
  // 搜标题能命中。
  const byTitle = buildConversationFindIndex(units, "鉴权结论");
  assert.equal(byTitle.matchCount, 1);
  // 搜正文其余内容能命中。
  const byBody = buildConversationFindIndex(units, "结论");
  assert.ok(byBody.matchCount >= 1);
});

test("搜索索引：无 title 引用整段消失，不污染匹配", () => {
  const units = [assistantUnit('见：:::zcode-session-citation{session=sess_a, text="原文"} 好')];
  const bySession = buildConversationFindIndex(units, "sess_a");
  assert.equal(bySession.matchCount, 0);
  const byBody = buildConversationFindIndex(units, "好");
  assert.equal(byBody.matchCount, 1);
});
