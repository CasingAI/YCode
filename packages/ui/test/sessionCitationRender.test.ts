import assert from "node:assert/strict";
import test from "node:test";
// 会话引用真管线渲染测试：走真实 MessageResponse（预解析→remark→sanitize/harden→
// Streamdown→a 渲染器）SSR，覆盖纯函数单测到不了的安全层拦截（docs/specs/
// assistant-session-citation.md「安全层放行」）。计划验收场景 1/2/5。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../src/components/ai-elements/message.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

function renderSessionCitation(markdown: string, allowed?: ReadonlySet<string>): string {
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
            sessionCitationAllowedSessionIds: allowed,
            onOpenSessionCitation: () => {},
          },
          markdown,
        ),
      ),
    ),
  );
}

test("场景1：星号片段经真管线渲染成可点芯片", () => {
  const markup = renderSessionCitation(
    '结论：:::zcode-session-citation{session=sess_a, text="改过*鉴权*要点"} 完。',
    new Set(["sess_a"]),
  );
  assert.ok(!markup.includes("zcode-session-citation{"), `指令原文泄漏:\n${markup}`);
  assert.ok(markup.includes("<button"), `芯片不是可点button:\n${markup}`);
  // 链文里的 * 按 markdown 语义成 emphasis（所见结构），文本语义不断。
  assert.ok(markup.includes("改过") && markup.includes("鉴权") && markup.includes("要点"));
  assert.ok(markup.includes('title="sess_a"'));
});

test("场景2：反引号片段经真管线渲染成可点芯片", () => {
  const markup = renderSessionCitation(
    '结论：:::zcode-session-citation{session=sess_a, text="调用 `read` 工具"} 完。',
    new Set(["sess_a"]),
  );
  assert.ok(!markup.includes("zcode-session-citation{"), `指令原文泄漏:\n${markup}`);
  assert.ok(markup.includes("<button"), `芯片不是可点button:\n${markup}`);
});

test("场景5a：白名单外经真管线留原文不可点", () => {
  const markup = renderSessionCitation(
    ':::zcode-session-citation{session=sess_evil, text="x"}',
    new Set(["sess_a"]),
  );
  assert.ok(markup.includes("zcode-session-citation{"), `白名单外不应转链接:\n${markup}`);
  assert.ok(!markup.includes("<button"), `白名单外不应成芯片:\n${markup}`);
});

test("场景5b：代码块内指令经真管线不转", () => {
  const markup = renderSessionCitation(
    '```\n:::zcode-session-citation{session=sess_a, text="x"}\n```',
    new Set(["sess_a"]),
  );
  // 代码块自带复制/换行 button，断言收紧为无会话芯片（芯片带 title=sessionId）。
  assert.ok(!markup.includes('title="sess_a"'), `代码块内不应成会话芯片:\n${markup}`);
});

test("场景5c：旧zcode-session链接经真管线仍成芯片", () => {
  const markup = renderSessionCitation(
    "[旧片段](zcode-session:sess_a?text=旧片段)",
    new Set(["sess_a"]),
  );
  assert.ok(markup.includes("<button"), `旧链应仍成芯片:\n${markup}`);
  assert.ok(markup.includes("旧片段"), `旧链链文丢失:\n${markup}`);
});
