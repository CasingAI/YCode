import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import {
  MarkdownDetails,
  MarkdownSummary,
} from "../src/components/ai-elements/markdown-details.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        Streamdown,
        {
          components: { details: MarkdownDetails, summary: MarkdownSummary },
        },
        markdown,
      ),
    ),
  );
}

test("markdown 里的 details 渲染成默认收起的折叠卡片", () => {
  const markup = renderMarkdown(
    [
      "下面是三个观点：",
      "",
      "<details>",
      "<summary>三个可能造成重复写入的失败点</summary>",
      "",
      "**并发写入冲突。** 后写覆盖先写。",
      "",
      "</details>",
      "",
      "正文结束。",
    ].join("\n"),
  );

  assert.ok(markup.includes('aria-expanded="false"'), "折叠卡片默认收起");
  assert.ok(markup.includes("三个可能造成重复写入的失败点"), "summary 文本进卡片标题");
  assert.ok(markup.includes("并发写入冲突"), "正文在折叠区里");
  assert.ok(markup.includes("正文结束"), "折叠块之外的正文不受影响");
  assert.ok(!markup.includes("<details"), "不落到裸 details 标签");
});

test("details 内的 markdown 块级元素正常解析", () => {
  const markup = renderMarkdown(
    [
      "<details>",
      "<summary>步骤</summary>",
      "",
      "1. 第一步",
      "2. 第二步",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "</details>",
    ].join("\n"),
  );

  assert.ok(markup.includes("第一步"), "有序列表解析");
  assert.ok(markup.includes("const a = 1;"), "代码块解析");
  assert.ok(markup.includes("<ol"), "列表渲染为块级元素而不是并入标题");
});
