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

function historySearchToolCall(citations: Array<Record<string, unknown>>) {
  return {
    kind: "toolCall",
    rowId: 2,
    toolCallId: "call_1",
    toolName: "HistorySearch",
    status: "success",
    inputText: "{}",
    output: {
      text: "检索…",
      display: { kind: "history_search", query: "鉴权", hitCount: citations.length, citations },
    },
  };
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

test("来源从正文引用指令抽取：按会话去重，首命中保留；白名单外丢掉", () => {
  const content = selectAiSearchAnswerContent(
    stateWithRows([
      assistantText(
        "结论：：::zcode-session-citation{session=sess_a, text=\"鉴权改了\", segment=2, title=\"会话A\"} " +
          "还有：::zcode-session-citation{session=sess_a, text=\"鉴权又改了\", segment=5} " +
          "以及：::zcode-session-citation{session=sess_b, text=\"鉴权相关\"} " +
          "编的：::zcode-session-citation{session=sess_evil, text=\"假的\"}",
      ),
      historySearchToolCall([
        { sessionId: "sess_a", title: "会话A", segment: 2, role: "assistant", snippet: "…鉴权…" },
        { sessionId: "sess_b", title: null, segment: 1, role: "assistant", snippet: "…鉴权…" },
      ]),
      {
        kind: "toolCall",
        rowId: 3,
        toolCallId: "call_2",
        toolName: "HistorySearch",
        status: "running",
        inputText: "{}",
      },
    ]),
  );
  // sess_a 去重只留首条；sess_evil 不在白名单被丢掉。
  assert.equal(content.citations.length, 2);
  assert.equal(content.citations[0]?.sessionId, "sess_a");
  assert.equal(content.citations[0]?.segment, 2);
  assert.equal(content.citations[0]?.snippet, "鉴权改了");
  assert.equal(content.citations[0]?.title, "会话A");
  assert.equal(content.citations[1]?.sessionId, "sess_b");
  assert.equal(content.citations[1]?.title, null);
});

test("非法引用被丢弃（缺 session / 无原文片段 / 白名单外）", () => {
  const content = selectAiSearchAnswerContent(
    stateWithRows([
      assistantText(
        "坏1：::zcode-session-citation{text=\"无会话\"} " +
          "坏2：::zcode-session-citation{session=sess_a} " +
          "坏3：::zcode-session-citation{session=sess_evil, text=\"不在白名单\"} " +
          "好：::zcode-session-citation{session=sess_c, text=\"好\", segment=1, title=\"合法\"}",
      ),
      historySearchToolCall([
        { sessionId: "sess_a", title: "段号非法", segment: 1, role: "assistant", snippet: "x" },
        { sessionId: "sess_c", title: "合法", segment: 1, role: "assistant", snippet: "…好…" },
      ]),
    ]),
  );
  // 坏1 无 session（解析即丢）、坏2 无 text（无法定位）、坏3 白名单外。
  assert.deepEqual(
    content.citations.map((c) => c.sessionId),
    ["sess_c"],
  );
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
        "结论：::zcode-session-citation{session=sess_a, text=\"x\"}",
      ),
      historySearchToolCall([
        { sessionId: "sess_a", title: "会话A", segment: 1, role: "assistant", snippet: "x", at: 1700000000000 },
      ]),
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
  );
  assert.equal(content.activeTool?.toolName, "HistoryRead");
  assert.equal(content.activeTool?.running, true);
  assert.deepEqual(content.activeTool?.input, { sessionId: "sess_a" });
  // 引用从正文抽取（经白名单），与工具行状态无关。
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

  // 正文引用不在白名单（无工具行）时同样为空。
  const unlisted = selectAiSearchAnswerContent(
    stateWithRows([
      assistantText("结论：::zcode-session-citation{session=sess_a, text=\"x\"}"),
    ]),
  );
  assert.deepEqual(unlisted.citations, []);
});
