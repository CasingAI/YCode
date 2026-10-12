import assert from "node:assert/strict";
import test from "node:test";
import {
  citationJumpText,
  selectAiSearchAnswerContent,
} from "../src/command-center/aiSearchAnswerContent.js";
import type { ConversationStoreState } from "../src/v4/conversationProjectionStore.js";

function stateWithRows(rows: Array<Record<string, unknown>>): ConversationStoreState {
  return {
    snapshot: { control: { sessionEnded: false, phase: "running" }, rows: { window: rows } },
  } as unknown as ConversationStoreState;
}

function stateWithControl(
  control: Record<string, unknown>,
  rows: Array<Record<string, unknown>>,
): ConversationStoreState {
  return {
    snapshot: { control, rows: { window: rows } },
  } as unknown as ConversationStoreState;
}

function assistantText(text: string, state = "complete") {
  return { kind: "assistantText", rowId: 1, text, state };
}

test("空投影返回空内容（同一对象引用）", () => {
  const content = selectAiSearchAnswerContent(null);
  assert.equal(content.answerText, "");
  assert.equal(content.streaming, false);
  assert.deepEqual(content.citations, []);
});

test("归纳正文只取最后一条完成消息，不读 userInput 行", () => {
  const content = selectAiSearchAnswerContent(
    stateWithRows([
      { kind: "userInput", rowId: 0, text: "指令+问题" },
      assistantText("中间过程：先检索。"),
      assistantText("最终结论：改了鉴权。"),
      assistantText("还没写完…", "streaming"),
    ]),
  );
  // 最终答案 = 最后一条完成态；流式中的中间文字只进顶部预览。
  assert.equal(content.answerText, "最终结论：改了鉴权。");
  assert.equal(content.previewLine, "还没写完…");
  assert.ok(!content.answerText.includes("指令"));
  assert.ok(!content.answerText.includes("中间过程"));
  assert.equal(content.streaming, true);
  assert.equal(content.completed, false);
});

test("来源从正文 ycode 链接抽取：按会话去重，首命中保留；不存在会话丢掉", () => {
  const content = selectAiSearchAnswerContent(
    stateWithRows([
      assistantText(
        "结论：[鉴权改了](ycode://session/open?sessionId=sess_a&search=鉴权改了) " +
          "还有：[鉴权又改了](ycode://session/open?sessionId=sess_a&search=鉴权又改了) " +
          "以及：[鉴权相关](ycode://session/open?sessionId=sess_b&search=鉴权相关) " +
          "编的：[假的](ycode://session/open?sessionId=sess_evil&search=假的)",
      ),
    ]),
    { existingSessionIds: new Set(["sess_a", "sess_b"]) },
  );
  // sess_a 去重只留首条；sess_evil 不在存在性集合被丢掉。
  assert.equal(content.citations.length, 2);
  assert.equal(content.citations[0]?.sessionId, "sess_a");
  assert.equal(content.citations[0]?.segment, 1);
  assert.equal(content.citations[0]?.snippet, "鉴权改了");
  assert.equal(content.citations[0]?.title, "鉴权改了");
  assert.equal(content.citations[1]?.sessionId, "sess_b");
  assert.equal(content.citations[1]?.title, "鉴权相关");
});

test("非法引用被丢弃（缺 session / 无原文片段 / 不存在会话）", () => {  const content = selectAiSearchAnswerContent(
    stateWithRows([
      assistantText(
        "坏1：[无会话](ycode://session/open?search=无会话) " +
          "坏2：[x](ycode://session/open?sessionId=sess_a) " +
          "坏3：[不存在](ycode://session/open?sessionId=sess_evil&search=不存在) " +
          "好：[好](ycode://session/open?sessionId=sess_c&search=好)",
      ),
    ]),
    { existingSessionIds: new Set(["sess_a", "sess_c"]) },
  );
  // 坏1 无 session（解析即丢）、坏2 无 search 且链文为 x 但 search 缺席（无法定位）、坏3 不存在会话。
  assert.deepEqual(
    content.citations.map((c) => c.sessionId),
    ["sess_c"],
  );
});

test("遗留指令块不进来源，且答案正文与预览永不带出指令原文", () => {
  const content = selectAiSearchAnswerContent(
    stateWithRows([
      assistantText(
        '结论：:::zcode-session-citation{session=sess_a, text="鉴权原文", segment=2, title="会话A"} 好',
      ),
    ]),
    { existingSessionIds: new Set(["sess_a"]) },
  );
  // 遗留指令不恢复兼容：不进来源。
  assert.deepEqual(content.citations, []);
  // 答案正文与顶部预览只留纯文本片段，不带指令语法与字段。
  for (const text of [content.answerText, content.previewLine]) {
    assert.ok(!text.includes("zcode-session-citation"), `指令语法泄漏:\n${text}`);
    assert.ok(!text.includes("session="), `字段泄漏:\n${text}`);
    assert.ok(!text.includes("segment="), `字段泄漏:\n${text}`);
    assert.ok(!text.includes("title="), `字段泄漏:\n${text}`);
  }
  assert.ok(content.answerText.includes("鉴权原文"), `text 文本丢失:\n${content.answerText}`);
  assert.ok(content.previewLine.includes("鉴权原文"), `text 文本丢失:\n${content.previewLine}`);
});

test("存在性集合缺席 = 不校验（fail-open），全部保留", () => {
  const content = selectAiSearchAnswerContent(
    stateWithRows([
      assistantText("结论：[x](ycode://session/open?sessionId=sess_a&search=x)"),
    ]),
  );
  assert.equal(content.citations.length, 1);
  assert.equal(content.citations[0]?.sessionId, "sess_a");
});

test("跳转文本去掉【】标记与省略号", () => {
  assert.equal(citationJumpText("…讨论【鉴权】与修复…"), "讨论鉴权与修复");
  assert.equal(citationJumpText("  "), "");
});

test("顶部第一行：最新一条正文空白折叠成单行", () => {
  const content = selectAiSearchAnswerContent(
    stateWithRows([
      assistantText("第一段结论。"),
      assistantText("最新一版：\n第二行依据。\n\n第三段。"),
    ]),
  );
  // 预览取最新一条；最终答案取最后一条完成。
  assert.equal(content.previewLine, "最新一版： 第二行依据。 第三段。");
  assert.equal(content.answerText, "最新一版：\n第二行依据。\n\n第三段。");
});

test("顶部第二行：永远是最后一次工具调用，携带 display 与 input", () => {
  const content = selectAiSearchAnswerContent(
    stateWithRows([
      assistantText(
        "结论：[x](ycode://session/open?sessionId=sess_a&search=x)",
      ),
      {
        kind: "toolCall",
        rowId: 3,
        toolCallId: "call_2",
        toolName: "HistoryRead",
        status: "running",
        inputText: "{}",
        input: { sessionId: "sess_a" },
      },
    ]),
    { existingSessionIds: new Set(["sess_a"]) },
  );
  assert.equal(content.activeTool?.toolName, "HistoryRead");
  assert.equal(content.activeTool?.running, true);
  assert.deepEqual(content.activeTool?.input, { sessionId: "sess_a" });
  // 引用从正文抽取（经存在性校验），与工具行状态无关。
  assert.equal(content.citations.length, 1);
  assert.equal(content.citations[0]?.sessionId, "sess_a");
});

test("收口语义：sessionEnded 完成后 completed=true；error 时读服务端文案", () => {
  const done = selectAiSearchAnswerContent(
    stateWithControl(
      { sessionEnded: true, phase: "completedSuccess", lastError: null },
      [assistantText("最终结论。")],
    ),
  );
  assert.equal(done.completed, true);
  assert.equal(done.turnFailed, false);
  assert.equal(done.turnError, null);
  assert.equal(done.answerText, "最终结论。");

  const failed = selectAiSearchAnswerContent(
    stateWithControl(
      { sessionEnded: false, phase: "error", lastError: { message: "模型调用失败" } },
      [assistantText("写了一半")],
    ),
  );
  assert.equal(failed.completed, false);
  assert.equal(failed.turnFailed, true);
  assert.equal(failed.turnError, "模型调用失败");
});

test("无工具调用时 activeTool 为 null；正文无引用则来源为空", () => {
  const empty = selectAiSearchAnswerContent(stateWithRows([assistantText("结论")]));
  assert.equal(empty.activeTool, null);
  assert.equal(empty.previewLine, "结论");
  assert.deepEqual(empty.citations, []);

  // 存在性集合限定单个会话时，不在集合的引用被丢掉。
  const unlisted = selectAiSearchAnswerContent(
    stateWithRows([
      assistantText("结论：[x](ycode://session/open?sessionId=sess_a&search=x)"),
    ]),
    { existingSessionIds: new Set(["sess_other"]) },
  );
  assert.deepEqual(unlisted.citations, []);
});
