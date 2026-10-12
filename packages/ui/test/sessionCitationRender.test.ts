import assert from "node:assert/strict";
import test from "node:test";
// 会话引用真管线渲染测试：走真实 MessageResponse（remark→sanitize/harden→
// Streamdown→a 渲染器）SSR，覆盖纯函数单测到不了的安全层拦截（docs/specs/
// assistant-session-citation.md「安全层放行」）。唯一载体是 ycode Markdown 链接。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../src/components/ai-elements/message.js";
import { projectLegacyZCodeSessionCitationDirectives } from "../src/lib/zcodeSessionCitation.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

function renderSessionCitation(
  markdown: string,
  existing?: ReadonlySet<string>,
  streaming = false,
): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TooltipProvider,
        null,
        createElement(
          MessageResponse,
          {
            renderZCodeSessionCitations: true,
            sessionCitationExistingSessionIds: existing,
            streaming,
            onOpenSessionCitation: () => {},
          },
          markdown,
        ),
      ),
    ),
  );
}

test("直出链接渲染成可点芯片", () => {
  const markup = renderSessionCitation(
    "结论：[改过鉴权要点](ycode://session/open?sessionId=sess_a&search=改过鉴权要点) 完。",
    new Set(["sess_a"]),
  );
  assert.ok(!markup.includes("ycode://"), `裸 URL 泄漏:\n${markup}`);
  assert.ok(markup.includes("<button"), `芯片不是可点button:\n${markup}`);
  assert.ok(markup.includes("改过鉴权要点"));
  assert.ok(markup.includes('title="sess_a"'));
});

test("未编码中文 search 照常成芯片", () => {
  const markup = renderSessionCitation(
    "[鉴权结论已合入](ycode://session/open?sessionId=sess_a&search=鉴权结论已合入)",
    new Set(["sess_a"]),
  );
  assert.ok(markup.includes("<button"), `未编码链接应成芯片:\n${markup}`);
  assert.ok(markup.includes("鉴权结论已合入"));
});

test("无效 sessionId 只显示文本、不可点、不露裸 URL", () => {
  const markup = renderSessionCitation(
    "[伪造片段](ycode://session/open?sessionId=sess_evil&search=伪造片段)",
    new Set(["sess_a"]),
  );
  assert.ok(markup.includes("伪造片段"), `链接文本丢失:\n${markup}`);
  assert.ok(!markup.includes("<button"), `无效引用不应成芯片:\n${markup}`);
  assert.ok(!markup.includes("ycode://"), `裸 URL 泄漏:\n${markup}`);
  assert.ok(!markup.includes("sess_evil"), `sessionId 不应露出:\n${markup}`);
});

test("已归档会话引用能渲染（存在性集合含归档即成芯片）", () => {
  const markup = renderSessionCitation(
    "[归档里的结论](ycode://session/open?sessionId=sess_archived&search=归档里的结论)",
    new Set(["sess_archived"]),
  );
  assert.ok(markup.includes("<button"), `归档会话应成芯片:\n${markup}`);
  assert.ok(markup.includes("归档里的结论"));
});

test("遗留指令块一律剥离成纯文本：永不显示原文，不做芯片、不可点", () => {
  const markup = renderSessionCitation(
    '结论：:::zcode-session-citation{session=sess_a, text="原文片段", segment=2, title="会话A"} 好',
    new Set(["sess_a"]),
  );
  // 指令语法与字段名永不出现；text 以纯文本出现；不做芯片。
  assert.ok(!markup.includes("zcode-session-citation"), `指令语法泄漏:\n${markup}`);
  assert.ok(!markup.includes("session="), `字段泄漏:\n${markup}`);
  assert.ok(!markup.includes("segment="), `字段泄漏:\n${markup}`);
  assert.ok(!markup.includes("title="), `字段泄漏:\n${markup}`);
  assert.ok(!markup.includes("sess_a"), `sessionId 泄漏:\n${markup}`);
  assert.ok(markup.includes("原文片段"), `text 文本丢失:\n${markup}`);
  assert.ok(!markup.includes("<button"), `遗留指令不应成芯片:\n${markup}`);
});

test("遗留指令块剥离退化：无 text 时退 title，都没有整段丢弃", () => {
  const byTitle = renderSessionCitation(
    '见:::zcode-session-citation{session=sess_a, title="会话A"} 好',
    new Set(["sess_a"]),
  );
  assert.ok(!byTitle.includes("zcode-session-citation"), `指令语法泄漏:\n${byTitle}`);
  assert.ok(!byTitle.includes("session="), `字段泄漏:\n${byTitle}`);
  assert.ok(byTitle.includes("会话A"), `title 文本丢失:\n${byTitle}`);
  assert.ok(!byTitle.includes("<button"), `遗留指令不应成芯片:\n${byTitle}`);

  const dropped = renderSessionCitation(
    "见:::zcode-session-citation{session=sess_a} 好",
    new Set(["sess_a"]),
  );
  assert.ok(!dropped.includes("zcode-session-citation"), `指令语法泄漏:\n${dropped}`);
  assert.ok(!dropped.includes("session="), `字段泄漏:\n${dropped}`);
  assert.ok(!dropped.includes("<button"), `遗留指令不应成芯片:\n${dropped}`);
});

test("遗留指令块单冒号与智能引号同样剥离", () => {
  const markup = renderSessionCitation(
    '结论：:zcode-session-citation{title="后来居上", text=“带空格原文”, session=sess_a} 好',
    new Set(["sess_a"]),
  );
  assert.ok(!markup.includes("zcode-session-citation"), `指令语法泄漏:\n${markup}`);
  assert.ok(!markup.includes("session="), `字段泄漏:\n${markup}`);
  assert.ok(markup.includes("带空格原文"), `text 文本丢失:\n${markup}`);
  assert.ok(!markup.includes("<button"), `遗留指令不应成芯片:\n${markup}`);
});

test("代码块内的遗留指令示例受保护、保持原文", () => {
  // SSR 下代码块内容由客户端高亮（markup 里本来就没有代码文本），这里断言纯函数：
  // 有意展示的代码示例不算遗留内容，保持原文。
  const out = projectLegacyZCodeSessionCitationDirectives(
    '```\n:::zcode-session-citation{session=sess_a, text="x"}\n```',
    { streaming: false },
  );
  assert.ok(out.includes("zcode-session-citation"), `代码块示例应保留:\n${out}`);
});

test("旧 zcode-session 链接按普通文本显示", () => {
  const markup = renderSessionCitation(
    "[旧片段](zcode-session:sess_a?text=旧片段)",
    new Set(["sess_a"]),
  );
  assert.ok(!markup.includes("<button"), `旧链不应成芯片:\n${markup}`);
});

test("流式未闭合链接：占位芯片固定结构、不可点、带最小宽度", () => {
  const markup = renderSessionCitation(
    "结论：[之前有做](ycode://session/open?sessionId=sess_a&sea",
    new Set(["sess_a"]),
    true,
  );
  // 未闭合尾巴不泄漏，转成占位芯片。
  assert.ok(!markup.includes("ycode://session/open"), `半截 URL 泄漏:\n${markup}`);
  assert.ok(
    markup.includes("data-session-citation-placeholder"),
    `应有占位芯片:\n${markup}`,
  );
  assert.ok(markup.includes("min-w-24"), `占位应有固定最小宽度:\n${markup}`);
  // 占位不可点：同段内不应出现可点 button。
  assert.ok(!markup.includes("<button"), `占位不应可点:\n${markup}`);
});

test("流式未闭合链接不存在会话：只截断、不占位", () => {
  const markup = renderSessionCitation(
    "结论：[x](ycode://session/open?sessionId=sess_evil",
    new Set(["sess_a"]),
    true,
  );
  assert.ok(!markup.includes("data-session-citation-placeholder"), `不应占位:\n${markup}`);
  assert.ok(!markup.includes("sess_evil"), `sessionId 不应露出:\n${markup}`);
});

test("代码块内 ycode 链接不转芯片", () => {
  const markup = renderSessionCitation(
    "```\n[x](ycode://session/open?sessionId=sess_a)\n```",
    new Set(["sess_a"]),
  );
  // 代码块自带复制/换行 button，断言收紧为无会话芯片（芯片带 title=sessionId）。
  assert.ok(!markup.includes('title="sess_a"'), `代码块内不应成会话芯片:\n${markup}`);
});
