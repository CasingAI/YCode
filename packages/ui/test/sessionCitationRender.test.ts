import assert from "node:assert/strict";
import test from "node:test";
// 会话引用真管线渲染测试：走真实 MessageResponse（remark→sanitize/harden→
// Streamdown→a 渲染器）SSR，覆盖纯函数单测到不了的安全层拦截（docs/specs/
// assistant-session-citation.md「安全层放行」）。唯一载体是 ycode Markdown 链接。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../src/components/ai-elements/message.js";
import {
  extractZCodeSessionCitationLinks,
  parseZCodeSessionCitationUrl,
  projectLegacyZCodeSessionCitationDirectives,
} from "../src/lib/zcodeSessionCitation.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

/** 用生产构造语义生成合法链接：签名默认 `%20` 形式；传 `+` 时使用 `URLSearchParams` 原始输出。 */
function citationUrl(text: string, spaceForm: "%20" | "+" = "%20"): string {
  const query = new URLSearchParams({ sessionId: "sess_a", search: text }).toString();
  return `ycode://session/open?${spaceForm === "+" ? query : query.replaceAll("+", "%20")}`;
}

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

test("未编码中文（无空格）search 照常成芯片", () => {
  const markup = renderSessionCitation(
    "[鉴权结论已合入](ycode://session/open?sessionId=sess_a&search=鉴权结论已合入)",
    new Set(["sess_a"]),
  );
  assert.ok(markup.includes("<button"), `未编码链接应成芯片:\n${markup}`);
  assert.ok(markup.includes("鉴权结论已合入"));
});

test("search 编码契约：%20 与 + 形式都渲染成芯片且解码回原文", () => {
  // 回归：裸空格会终止 CommonMark 行内链接目标；这里用真实 MessageResponse 管线锁住
  // 两种合法空格形式，覆盖中英文空格、字面 +、& # 括号 % 等必须编码的字符。
  const original = "auth conclusion landed + Q&A #1 (100%) 找到 90 件";
  for (const spaceForm of ["%20", "+"] as const) {
    const url = citationUrl(original, spaceForm);
    assert.ok(!url.includes(" "), `${spaceForm} 形式不应含裸空格: ${url}`);
    const markdown = `结论见[来源片段](${url})。`;

    const markup = renderSessionCitation(markdown, new Set(["sess_a"]));
    assert.ok(markup.includes("<button"), `${spaceForm} 应渲染成可点芯片:\n${markup}`);
    assert.ok(markup.includes('title="sess_a"'), `${spaceForm} 芯片缺少会话 id:\n${markup}`);
    assert.ok(markup.includes("来源片段"), `${spaceForm} 链接文本丢失:\n${markup}`);
    assert.ok(!markup.includes("ycode://"), `${spaceForm} 裸 URL 泄漏:\n${markup}`);
    assert.ok(!markup.includes("](ycode://"), `${spaceForm} 链接未解析:\n${markup}`);

    // 来源抽取与 URL 解析读到的 search 必须还原成同一份原文，不因编码丢失或改写。
    const extracted = extractZCodeSessionCitationLinks(markdown);
    assert.equal(extracted.length, 1, `${spaceForm} 来源抽取条数:\n${markdown}`);
    assert.equal(extracted[0]?.session, "sess_a");
    assert.equal(extracted[0]?.text, "来源片段");
    assert.equal(extracted[0]?.search, original, `${spaceForm} search 解码不一致`);
    assert.equal(parseZCodeSessionCitationUrl(url)?.text, original, `${spaceForm} URL 解码不一致`);
  }
});

test("details 内的合法编码引用同样渲染成芯片并正确抽取", () => {
  const original = "当时的物品接口实测记录 90 件";
  const markdown = [
    "<details>",
    "",
    "<summary>相关记录</summary>",
    "",
    `[当时的物品接口实测记录](${citationUrl(original)})`,
    "",
    "</details>",
  ].join("\n");
  const markup = renderSessionCitation(markdown, new Set(["sess_a"]));
  assert.ok(markup.includes("<button"), `details 内引用应成芯片:\n${markup}`);
  assert.ok(markup.includes('title="sess_a"'), `details 内芯片缺少会话 id:\n${markup}`);
  assert.ok(!markup.includes("](ycode://"), `details 内链接未解析:\n${markup}`);

  const extracted = extractZCodeSessionCitationLinks(markdown);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0]?.search, original);
});

test("裸空格 malformed 链接不自动修复：保留原文、不可点、不抽来源", () => {
  // 明确不做预解析修复：旧消息里的裸空格目标继续按原文显示，只有新生成链接按编码规则产出。
  const markdown =
    "[当时的物品接口实测记录](ycode://session/open?sessionId=sess_a&search=当时 的接口实测记录)";
  const markup = renderSessionCitation(markdown, new Set(["sess_a"]));
  assert.ok(!markup.includes("<button"), `malformed 不应自动成芯片:\n${markup}`);
  assert.ok(markup.includes("](ycode://session/open"), `malformed 应保留原文:\n${markup}`);
  assert.equal(extractZCodeSessionCitationLinks(markdown).length, 0, "malformed 不应被抽取");
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
