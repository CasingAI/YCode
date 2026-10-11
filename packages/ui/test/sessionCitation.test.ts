import assert from "node:assert/strict";
import test from "node:test";
import {
  buildZCodeSessionCitationUrl,
  convertZCodeSessionCitationsToLinks,
  extractZCodeSessionCitations,
  parseZCodeSessionCitationUrl,
  projectZCodeSessionCitations,
} from "../src/lib/zcodeSessionCitation.js";
import { resolveSessionCitationWorkspace } from "../src/lib/sessionCitationWorkspace.js";

test("抽取：session必填，代码块内丢掉", () => {
  const citations = extractZCodeSessionCitations(
    '看这个：:::zcode-session-citation{session=sess_a, text="原文", segment=2, title="标题"} 好',
  );
  assert.equal(citations.length, 1);
  assert.equal(citations[0]?.session, "sess_a");
  assert.equal(citations[0]?.text, "原文");
  assert.equal(citations[0]?.segment, 2);
  assert.equal(citations[0]?.title, "标题");

  // 无 session 的丢掉。
  assert.deepEqual(extractZCodeSessionCitations(':::zcode-session-citation{text="x"}'), []);
  // 代码块内的不解析。
  assert.deepEqual(
    extractZCodeSessionCitations("```\n:::zcode-session-citation{session=sess_a}\n```"),
    [],
  );
});

test("抽取：单冒号与智能引号兼容", () => {
  const single = extractZCodeSessionCitations(":zcode-session-citation{session=sess_b}");
  assert.equal(single.length, 1);
  assert.equal(single[0]?.session, "sess_b");

  const smart = extractZCodeSessionCitations(
    ":::zcode-session-citation{session=sess_c, text=“带空格原文”}",
  );
  assert.equal(smart.length, 1);
  assert.equal(smart[0]?.text, "带空格原文");
});

test("抽取：非法段号丢掉段号但保留引用", () => {
  const citations = extractZCodeSessionCitations(
    ':::zcode-session-citation{session=sess_a, segment=0, text="x"}',
  );
  assert.equal(citations.length, 1);
  assert.equal(citations[0]?.segment, undefined);
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
  // segment/title 不再产出。
  assert.ok(!url.includes("segment="));
  assert.ok(!url.includes("title="));
  const parsed = parseZCodeSessionCitationUrl(url);
  assert.equal(parsed?.session, "sess_a");
  assert.equal(parsed?.text, "原文片段");

  // 非本 scheme 返回 null；空 session 返回 null。
  assert.equal(parseZCodeSessionCitationUrl("https://example.com"), null);
  assert.equal(parseZCodeSessionCitationUrl("ycode://session/open"), null);
  assert.equal(parseZCodeSessionCitationUrl("ycode://session/open?sessionId=  "), null);
  // host/path 不对不认。
  assert.equal(parseZCodeSessionCitationUrl("ycode://other/open?sessionId=sess_a"), null);
  assert.equal(parseZCodeSessionCitationUrl("ycode://session/other?sessionId=sess_a"), null);
});

test("URL 兼容：旧 zcode-session 式与旧 text 参数名", () => {
  // 旧不透明形态继续解析。
  const legacy = parseZCodeSessionCitationUrl(
    "zcode-session:sess_a?text=原文片段&segment=3&title=标题",
  );
  assert.equal(legacy?.session, "sess_a");
  assert.equal(legacy?.text, "原文片段");
  assert.equal(legacy?.segment, 3);
  assert.equal(legacy?.title, "标题");
  assert.equal(parseZCodeSessionCitationUrl("zcode-session:"), null);
  assert.equal(parseZCodeSessionCitationUrl("zcode-session:  ?text=x"), null);
  // ycode 式带旧参数名 text 等同 search。
  const compat = parseZCodeSessionCitationUrl("ycode://session/open?sessionId=sess_a&text=旧片段");
  assert.equal(compat?.session, "sess_a");
  assert.equal(compat?.text, "旧片段");
});

test("预解析转链接：特殊字符片段切不碎，白名单外与代码块内留原文", () => {
  const allowed = new Set(["sess_a"]);
  // 含星号/反引号的片段：转成链接后由我方编码，markdown 切不碎。
  const star = convertZCodeSessionCitationsToLinks(
    '结论：:::zcode-session-citation{session=sess_a, text="改过*鉴权*要点"} 完。',
    allowed,
  );
  assert.ok(!star.includes("zcode-session-citation{"));
  assert.ok(star.includes("ycode://session/open?sessionId=sess_a&search="));
  // 链接可回环解析。
  const starUrl = star.match(/\(ycode:\/\/[^)]+\)/)?.[0].slice(1, -1) ?? "";
  assert.equal(parseZCodeSessionCitationUrl(starUrl)?.session, "sess_a");
  assert.equal(parseZCodeSessionCitationUrl(starUrl)?.text, "改过*鉴权*要点");

  const backtick = convertZCodeSessionCitationsToLinks(
    '结论：:::zcode-session-citation{session=sess_a, text="调用 `read` 工具"} 完。',
    allowed,
  );
  assert.ok(!backtick.includes("zcode-session-citation{"));
  assert.ok(backtick.includes("ycode://session/open?"));

  // 链文取 text，缺 text 时取 title、再缺取 session。
  assert.ok(star.startsWith("结论：[改过*鉴权*要点]("));
  const titled = convertZCodeSessionCitationsToLinks(
    '看:::zcode-session-citation{session=sess_a, title="会话A"} 好',
    allowed,
  );
  assert.ok(titled.includes("[会话A](ycode://session/open?"));

  // 白名单外留原文。
  const denied = convertZCodeSessionCitationsToLinks(
    ':::zcode-session-citation{session=sess_evil, text="x"}',
    allowed,
  );
  assert.ok(denied.includes("zcode-session-citation{"));

  // 不带白名单 = 不校验，全转。
  const noAllow = convertZCodeSessionCitationsToLinks(
    ':::zcode-session-citation{session=sess_any, text="x"}',
  );
  assert.ok(noAllow.includes("ycode://session/open?sessionId=sess_any"));

  // 代码块内不转。
  const fenced = convertZCodeSessionCitationsToLinks(
    '```\n:::zcode-session-citation{session=sess_a, text="x"}\n```',
    allowed,
  );
  assert.ok(fenced.includes("zcode-session-citation{"));
  assert.ok(!fenced.includes("ycode://"));

  // 无指令不动（同一引用返回）。
  assert.equal(convertZCodeSessionCitationsToLinks("普通正文", allowed), "普通正文");
});

test("预解析真实例子：spec 契约断言", () => {
  const converted = convertZCodeSessionCitationsToLinks(
    '结论：:::zcode-session-citation{session=sess_a, text="之前有做过", segment=4, title="会话A"} 完。',
    new Set(["sess_a"]),
  );
  assert.equal(
    converted,
    "结论：[之前有做过](ycode://session/open?sessionId=sess_a&search=%E4%B9%8B%E5%89%8D%E6%9C%89%E5%81%9A%E8%BF%87) 完。",
  );
});

test("流式投影：完成态转链接，流式只截未闭合尾部", () => {
  // 完成态：闭合指令转成链接（不再留原文）。
  const complete = projectZCodeSessionCitations("结论：:::zcode-session-citation{session=sess_a}", {
    streaming: false,
  });
  assert.ok(!complete.visibleText.includes("zcode-session-citation{"));
  assert.ok(complete.visibleText.includes("ycode://session/open?sessionId=sess_a"));

  // 流式未闭合截掉。
  const streaming = projectZCodeSessionCitations("结论：:::zcode-session-citation{session=sess_a", {
    streaming: true,
  });
  assert.equal(streaming.visibleText, "结论：");

  // 流式无指令不动。
  const plain = projectZCodeSessionCitations("普通正文", { streaming: true });
  assert.equal(plain.visibleText, "普通正文");
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
