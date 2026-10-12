import assert from "node:assert/strict";
import test from "node:test";
import {
  buildZCodeSessionCitationPendingUrl,
  buildZCodeSessionCitationUrl,
  extractZCodeSessionCitationLinks,
  parsePendingSessionCitationSessionId,
  parseZCodeSessionCitationPendingSessionId,
  parseZCodeSessionCitationSessionId,
  parseZCodeSessionCitationUrl,
  projectLegacyZCodeSessionCitationDirectives,
  projectZCodeSessionCitations,
  stripLegacyZCodeSessionCitationDirectives,
} from "../src/lib/zcodeSessionCitation.js";
import { resolveSessionCitationWorkspace } from "../src/lib/sessionCitationWorkspace.js";

test("抽取：只收闭合 ycode 链接，非法 session 与代码块内丢掉", () => {
  const citations = extractZCodeSessionCitationLinks(
    "看这个：[原文](ycode://session/open?sessionId=sess_a&search=原文) 好",
  );
  assert.equal(citations.length, 1);
  assert.equal(citations[0]?.session, "sess_a");
  assert.equal(citations[0]?.text, "原文");
  assert.equal(citations[0]?.search, "原文");

  // session 缺席的丢掉。
  assert.deepEqual(extractZCodeSessionCitationLinks("[x](ycode://session/open?search=x)"), []);
  // 代码块内的不解析。
  assert.deepEqual(
    extractZCodeSessionCitationLinks("```\n[x](ycode://session/open?sessionId=sess_a)\n```"),
    [],
  );
  // 老指令块按普通文本：不抽取。
  assert.deepEqual(
    extractZCodeSessionCitationLinks(':::zcode-session-citation{session=sess_a, text="x"}'),
    [],
  );
  // 旧 zcode-session 形态不收。
  assert.deepEqual(
    extractZCodeSessionCitationLinks("[x](zcode-session:sess_a?text=x)"),
    [],
  );
});

test("抽取：旧参数名 text 等同 search，空链文也收", () => {
  const compat = extractZCodeSessionCitationLinks(
    "[旧片段](ycode://session/open?sessionId=sess_a&text=旧片段)",
  );
  assert.equal(compat.length, 1);
  assert.equal(compat[0]?.search, "旧片段");
});

test("遗留指令块剥离：text 优先、退 title、都没有丢弃；单冒号与智能引号都认", () => {
  const byText = stripLegacyZCodeSessionCitationDirectives(
    '前:::zcode-session-citation{session=sess_a, text="原文片段", segment=2, title="会话A"} 后',
  );
  assert.ok(!byText.includes("zcode-session-citation"), `指令语法泄漏:\n${byText}`);
  assert.ok(!byText.includes("session="), `字段泄漏:\n${byText}`);
  assert.ok(!byText.includes("segment="), `字段泄漏:\n${byText}`);
  assert.ok(!byText.includes("title="), `字段泄漏:\n${byText}`);
  assert.ok(byText.includes("原文片段"), `text 文本丢失:\n${byText}`);

  const byTitle = stripLegacyZCodeSessionCitationDirectives(
    '前:zcode-session-citation{title="后来居上", session=sess_a} 后',
  );
  assert.ok(!byTitle.includes("zcode-session-citation"), `指令语法泄漏:\n${byTitle}`);
  assert.ok(byTitle.includes("后来居上"), `title 文本丢失:\n${byTitle}`);

  const smart = stripLegacyZCodeSessionCitationDirectives(
    '前:::zcode-session-citation{session=sess_a, text=“带空格原文”} 后',
  );
  assert.ok(smart.includes("带空格原文"), `智能引号 text 丢失:\n${smart}`);

  const dropped = stripLegacyZCodeSessionCitationDirectives(
    "前:::zcode-session-citation{session=sess_a} 后",
  );
  assert.ok(!dropped.includes("zcode-session-citation"), `指令语法泄漏:\n${dropped}`);
  assert.ok(!dropped.includes("sess_a"), `sessionId 泄漏:\n${dropped}`);

  // 代码块内的协议示例受保护。
  const fenced = stripLegacyZCodeSessionCitationDirectives(
    '```\n:::zcode-session-citation{session=sess_a, text="x"}\n```',
  );
  assert.ok(fenced.includes("zcode-session-citation"), `代码块示例应保留:\n${fenced}`);

  // 无指令块时原样返回。
  assert.equal(stripLegacyZCodeSessionCitationDirectives("普通正文"), "普通正文");
});

test("遗留指令块投影：完成态剥离闭合块，流式截掉未闭合尾巴", () => {
  const complete = projectLegacyZCodeSessionCitationDirectives(
    '结论见:::zcode-session-citation{session=sess_a, text="原文"} 好',
    { streaming: false },
  );
  assert.ok(!complete.includes("zcode-session-citation"), `指令语法泄漏:\n${complete}`);
  assert.ok(complete.includes("原文"), `text 文本丢失:\n${complete}`);

  const streamingTail = projectLegacyZCodeSessionCitationDirectives("结论见:::zcode-session-cita", {
    streaming: true,
  });
  assert.ok(
    !streamingTail.includes("zcode-session-cita"),
    `流式半截泄漏:\n${streamingTail}`,
  );
});

test("URL 编解码往返（ycode 双参规范式）", () => {
  const url = buildZCodeSessionCitationUrl({
    session: "sess_a",
    text: "原文片段",
  });
  // 规范式：ycode://session/open?sessionId=<id>&search=<编码>。
  assert.ok(url.startsWith("ycode://session/open?"));
  assert.ok(url.includes("sessionId=sess_a"));
  assert.ok(url.includes("search="));
  const parsed = parseZCodeSessionCitationUrl(url);
  assert.equal(parsed?.session, "sess_a");
  assert.equal(parsed?.text, "原文片段");

  // 未编码中文与空格照读（URLSearchParams 原生容忍）。
  const loose = parseZCodeSessionCitationUrl(
    "ycode://session/open?sessionId=sess_a&search=鉴权结论 已合入",
  );
  assert.equal(loose?.session, "sess_a");
  assert.equal(loose?.text, "鉴权结论 已合入");

  // 非本 scheme 返回 null；空 session 返回 null。
  assert.equal(parseZCodeSessionCitationUrl("https://example.com"), null);
  assert.equal(parseZCodeSessionCitationUrl("ycode://session/open"), null);
  assert.equal(parseZCodeSessionCitationUrl("ycode://session/open?sessionId=  "), null);
  // host/path 不对不认。
  assert.equal(parseZCodeSessionCitationUrl("ycode://other/open?sessionId=sess_a"), null);
  assert.equal(parseZCodeSessionCitationUrl("ycode://session/other?sessionId=sess_a"), null);
  // 旧 zcode-session 形态已清除：不认。
  assert.equal(parseZCodeSessionCitationUrl("zcode-session:sess_a?text=x"), null);
  // ycode 式带旧参数名 text 等同 search。
  const compat = parseZCodeSessionCitationUrl("ycode://session/open?sessionId=sess_a&text=旧片段");
  assert.equal(compat?.session, "sess_a");
  assert.equal(compat?.text, "旧片段");
});

test("单参 session 提取", () => {
  assert.equal(
    parseZCodeSessionCitationSessionId("ycode://session/open?sessionId=sess_a&search=x"),
    "sess_a",
  );
  assert.equal(parseZCodeSessionCitationSessionId("ycode://session/open"), null);
});

test("流式投影：完成态不动，未闭合 ycode 链接补固定宽度占位", () => {
  // 完成态：闭合链接不需要预解析，原样过。
  const complete = projectZCodeSessionCitations(
    "结论：[之前有做过](ycode://session/open?sessionId=sess_a&search=之前有做过)",
    { streaming: false },
  );
  assert.ok(complete.visibleText.includes("ycode://session/open?sessionId=sess_a"));

  // 流式：未闭合链接尾巴已写出 sessionId 时截掉尾巴并补 pending 占位链接（固定结构，可断言）。
  const streaming = projectZCodeSessionCitations(
    "结论：[之前有做](ycode://session/open?sessionId=sess_a&sea",
    { streaming: true },
  );
  assert.ok(!streaming.visibleText.includes("ycode://session/open?sessionId=sess_a&sea"));
  assert.ok(streaming.visibleText.includes("ycode://session/pending?sessionId=sess_a"));
  assert.equal(streaming.pendingSessionId, "sess_a");

  // 流式：拿不到 sessionId 的纯前缀不动（走正常 markdown 流式）。
  const streamingPrefix = projectZCodeSessionCitations("结论：[之前有做](ycode://sess", {
    streaming: true,
  });
  assert.equal(streamingPrefix.visibleText, "结论：[之前有做](ycode://sess");
  assert.equal(streamingPrefix.pendingSessionId, undefined);

  // 流式：不存在会话的半截不占位（存在性不通过），但回传 sessionId 供断言。
  const streamingEvil = projectZCodeSessionCitations(
    "结论：[x](ycode://session/open?sessionId=sess_evil",
    { streaming: true, existingSessionIds: new Set(["sess_a"]) },
  );
  assert.ok(!streamingEvil.visibleText.includes("pending"));
  assert.equal(streamingEvil.pendingSessionId, "sess_evil");

  // 流式无链接不动。
  const plain = projectZCodeSessionCitations("普通正文", { streaming: true });
  assert.equal(plain.visibleText, "普通正文");
});

test("pending 占位链接编解码往返", () => {
  const url = buildZCodeSessionCitationPendingUrl("sess_a");
  assert.ok(url.startsWith("ycode://session/pending?"));
  assert.equal(parseZCodeSessionCitationPendingSessionId(url), "sess_a");
  // 普通 open 链接不归 pending 解析管。
  assert.equal(
    parseZCodeSessionCitationPendingSessionId("ycode://session/open?sessionId=sess_a"),
    null,
  );
  assert.equal(parseZCodeSessionCitationPendingSessionId("https://example.com"), null);
});

test("半截 sessionId 提取：未闭合链接/缺席", () => {
  assert.equal(
    parsePendingSessionCitationSessionId("[之前有做](ycode://session/open?sessionId=sess_a&sea"),
    "sess_a",
  );
  assert.equal(
    parsePendingSessionCitationSessionId("[x](ycode://session/open?sessionId=sess_a"),
    "sess_a",
  );
  // 拿不到 sessionId 时 null。
  assert.equal(parsePendingSessionCitationSessionId("结论：[之前有做](ycode://sess"), null);
  assert.equal(parsePendingSessionCitationSessionId("普通正文"), null);
});

test("反查：优先同工作区，否则首条，找不到 null", () => {
  const items = [
    { taskId: "sess_a", workspacePath: "/w1" },
    { taskId: "sess_a", workspacePath: "/w2", workspaceIdentity: "id2" },
    { taskId: "sess_b", workspacePath: "/w1" },
  ];
  // 同工作区优先。
  assert.deepEqual(
    resolveSessionCitationWorkspace(items, "sess_a", {
      workspacePath: "/w2",
      workspaceIdentity: "id2",
    }),
    { workspacePath: "/w2", workspaceIdentity: "id2" },
  );
  // 不匹配回退首条。
  assert.deepEqual(resolveSessionCitationWorkspace(items, "sess_a", { workspacePath: "/w9" }), {
    workspacePath: "/w1",
  });
  // 找不到 null；空 id null。
  assert.equal(resolveSessionCitationWorkspace(items, "sess_x"), null);
  assert.equal(resolveSessionCitationWorkspace(items, "  "), null);
});
