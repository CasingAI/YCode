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

// React 在属性值里把 & 和 > 转义成实体，比较 class 前先还原。
function classNamesOf(tag: string): string[] {
  const classAttr = tag.match(/class="([^"]*)"/);
  assert.ok(classAttr, "标签带 class");
  return classAttr[1].replace(/&amp;/g, "&").replace(/&gt;/g, ">").split(/\s+/);
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

test("折叠区正文与顶层使用同一套块间距", () => {
  const markup = renderMarkdown(
    [
      "顶层段落一",
      "",
      "顶层段落二",
      "",
      "<details>",
      "<summary>标题</summary>",
      "",
      "内段一",
      "",
      "内段二",
      "",
      "</details>",
    ].join("\n"),
  );

  const rootTag = markup.match(/<div class="[^"]*"/);
  assert.ok(rootTag, "顶层根容器存在");
  const rootClasses = classNamesOf(rootTag[0]);
  assert.ok(rootClasses.includes("space-y-4"), "顶层容器提供块间距");

  const regionTag = markup.match(/<div[^>]*role="region"[^>]*>/);
  assert.ok(regionTag, "折叠区正文容器存在");
  const regionClasses = classNamesOf(regionTag[0]);

  assert.ok(regionClasses.includes("space-y-4"), "折叠区正文容器提供同样的块间距");
  assert.ok(regionClasses.includes("[&>*:first-child]:mt-0"), "首个子元素 margin 归零");
  assert.ok(regionClasses.includes("[&>*:last-child]:mb-0"), "末个子元素 margin 归零");
});
