import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * 取顶层容器的直接子元素。分组样式依赖「相邻折叠块是同级兄弟」，
 * 所以要按 DOM 层级判断，而不是在整段 HTML 里搜关键字。
 */
function topLevelChildren(markup: string): { tag: string; attrs: string }[] {
  const tagPattern = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  const children: { tag: string; attrs: string }[] = [];
  const openTags: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(markup)) !== null) {
    const [full, closing, tag, attrs] = match;
    const tagName = tag.toLowerCase();

    if (closing) {
      openTags.pop();
      continue;
    }

    if (full.endsWith("/>") || VOID_TAGS.has(tagName)) {
      if (openTags.length === 1) {
        children.push({ tag: tagName, attrs });
      }
      continue;
    }

    openTags.push(tagName);
    // 顶层容器是第一个元素，压入后栈深为 2 的就是它的直接子元素。
    if (openTags.length === 2) {
      children.push({ tag: tagName, attrs });
    }
  }

  return children;
}

function detailsBlock(summary: string, body: string): string {
  return ["<details>", `<summary>${summary}</summary>`, "", body, "", "</details>"].join("\n");
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

test("连续的折叠块是同级兄弟，可以被样式合并成一张卡片", () => {
  const markup = renderMarkdown(
    [detailsBlock("根因链路", "正文一"), "", detailsBlock("改了哪些地方", "正文二")].join("\n"),
  );

  const children = topLevelChildren(markup);
  const cardIndexes = children
    .map((child, index) => (child.attrs.includes('data-slot="markdown-details"') ? index : -1))
    .filter((index) => index >= 0);

  assert.equal(cardIndexes.length, 2, "两个折叠块都渲染在顶层容器里");
  assert.equal(
    cardIndexes[1] - cardIndexes[0],
    1,
    "两块紧挨着，中间没有其他块，相邻兄弟选择器才能把它们合并",
  );
});

test("中间插入其他块会打断连续，分组边界回到块自身", () => {
  const markup = renderMarkdown(
    [
      detailsBlock("根因链路", "正文一"),
      "",
      "夹在中间的段落",
      "",
      detailsBlock("改了哪些地方", "正文二"),
    ].join("\n"),
  );

  const children = topLevelChildren(markup);
  const cardIndexes = children
    .map((child, index) => (child.attrs.includes('data-slot="markdown-details"') ? index : -1))
    .filter((index) => index >= 0);

  assert.equal(cardIndexes.length, 2, "两个折叠块都在顶层容器里");
  assert.equal(cardIndexes[1] - cardIndexes[0], 2, "中间隔着段落，不再是相邻兄弟");
  assert.equal(children[cardIndexes[0] + 1].tag, "p", "中间确实是段落");
});

test("折叠块带分组锚点，样式文件声明了合并规则", () => {
  const markup = renderMarkdown(detailsBlock("标题", "正文"));
  assert.ok(
    markup.includes('data-slot="markdown-details"'),
    "折叠卡根节点带分组锚点，作为相邻兄弟选择器的落点",
  );

  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.ok(
    css.includes('[data-slot="markdown-details"] + [data-slot="markdown-details"]'),
    "样式声明了后一块接上前一块的规则",
  );
  assert.ok(
    css.includes('[data-slot="markdown-details"]:has(+ [data-slot="markdown-details"])'),
    "样式声明了前一块让出底圆角的规则",
  );
  for (const declaration of [
    "margin-top: 0",
    "margin-bottom: 0",
    "border-top-width: 0",
    "border-top-left-radius: 0",
    "border-bottom-left-radius: 0",
  ]) {
    assert.ok(css.includes(declaration), `合并规则包含 ${declaration}`);
  }
});
