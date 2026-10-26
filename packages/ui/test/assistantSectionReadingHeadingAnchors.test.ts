import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { decodeHTML } from "entities";
import ts from "typescript";
import { MessageResponse } from "../src/components/ai-elements/message.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  buildAssistantSectionDocument,
  normalizeAssistantSectionHeadingText,
  type AssistantSectionDocument,
} from "../src/lib/assistantSectionReading.js";
import { AssistantSectionReading } from "../src/v4/AssistantSectionReading.js";
import {
  clearAssistantSectionReadingScope,
  createAssistantSectionReadingRowKey,
  revealAssistantReadingRowForSearch,
} from "../src/store/assistantSectionReadingStore.js";

const source = ts.createSourceFile(
  "AssistantSectionReading.tsx",
  await readFile(new URL("../src/v4/AssistantSectionReading.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

interface RenderedHeading {
  textContent: string;
  dataset: Record<string, string>;
  closest: () => null;
}

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(MessageResponse, { streaming: false }, markdown),
    ),
  );
}

function renderedHeadings(markup: string, depth: number): RenderedHeading[] {
  return [...markup.matchAll(new RegExp(`<h${depth}\\b[^>]*>([\\s\\S]*?)</h${depth}>`, "g"))].map(
    (match) => ({
      textContent: decodeHTML(match[1]!.replace(/<[^>]*>/g, "")),
      dataset: {},
      closest: () => null,
    }),
  );
}

function markFullTextAnchors(document: AssistantSectionDocument, headings: RenderedHeading[]) {
  let effect: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "useLayoutEffect" &&
      node.arguments[0]?.getText(source).includes("expectedHeadings")
    ) {
      effect = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(effect, "全文标题锚点回调存在");
  const { outputText } = ts.transpileModule(`const effect = ${effect.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  // 用真实 renderer 的标题文本执行组件实际回调，覆盖解析文案与 DOM 文案之间的交接。
  new Function(
    "panelRef",
    "mode",
    "document",
    "normalizeAssistantSectionHeadingText",
    `${outputText}\neffect();`,
  )(
    { current: { querySelectorAll: () => headings } },
    "full",
    document,
    normalizeAssistantSectionHeadingText,
  );
}

test("HTML entity whitespace matches actual rendered headings when expanding the full answer", () => {
  const markdown = "## A&nbsp;B\n\nfirst\n\n## Next\n\nsecond";
  const document = buildAssistantSectionDocument(markdown);
  assert.ok(document);
  assert.equal(document.sections[0]!.title, "A B");
  const headings = renderedHeadings(renderMarkdown(markdown), 2);
  assert.equal(headings[0]!.textContent, "A\u00a0B");

  markFullTextAnchors(document, headings);

  assert.deepEqual(
    headings.map((heading) => heading.dataset.assistantSectionStart),
    document.sections.map((section) => (section.startOffset === 0 ? undefined : section.id)),
  );
});

test("literal entity text is decoded once before matching actual rendered headings", () => {
  const markdown = "## A &amp;nbsp; B\n\nfirst\n\n## Next\n\nsecond";
  const document = buildAssistantSectionDocument(markdown);
  assert.ok(document);
  assert.equal(document.sections[0]!.title, "A &nbsp; B");
  const headings = renderedHeadings(renderMarkdown(markdown), 2);
  assert.equal(headings[0]!.textContent, "A &nbsp; B");

  markFullTextAnchors(document, headings);

  assert.deepEqual(
    headings.map((heading) => heading.dataset.assistantSectionStart),
    document.sections.map((section) => (section.startOffset === 0 ? undefined : section.id)),
  );
});

test("same-depth HTML headings keep the complete real-renderer response without section controls", () => {
  const markdown = "<h2>One</h2>\n\n## One\n\nfirst\n\n## Two\n\nsecond";
  const document = buildAssistantSectionDocument(markdown);
  assert.equal(document, undefined);
  const markup = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(AssistantSectionReading, {
        rowId: 65,
        turnId: "turn-html-anchor",
        scopeKey: "reading-html-anchor-fallback",
        document,
        markdown,
        streaming: false,
        turnRunning: false,
        renderMarkdown: (text) => createElement(MessageResponse, { streaming: false }, text),
      }),
    ),
  );

  assert.deepEqual(
    renderedHeadings(markup, 2).map((heading) => heading.textContent),
    ["One", "One", "Two"],
  );
  assert.match(markup, /first/);
  assert.match(markup, /second/);
  assert.doesNotMatch(markup, /data-assistant-section-header|data-assistant-section-footer/);
});

test("a merged document title keeps the first full-text anchor at the panel origin", () => {
  const markdown = "# 总标题\n\n## 第一节\n\n正文\n\n## 第二节\n\n后续";
  const document = buildAssistantSectionDocument(markdown);
  assert.ok(document);
  assert.equal(document.sections[0]!.startOffset, 0);
  const scopeKey = "reading-merged-title-origin";
  const rowKey = createAssistantSectionReadingRowKey({ turnId: "merged-title", rowId: 67 });
  try {
    revealAssistantReadingRowForSearch(scopeKey, rowKey);
    const markup = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(AssistantSectionReading, {
          rowId: 67,
          turnId: "merged-title",
          scopeKey,
          document,
          markdown,
          streaming: false,
          turnRunning: false,
          renderMarkdown: (text) => createElement(MessageResponse, { streaming: false }, text),
        }),
      ),
    );
    assert.match(
      markup,
      new RegExp(
        `data-assistant-section-start="${document.sections[0]!.id}"[^>]*><[^>]+[\\s\\S]*总标题`,
      ),
    );
    const headings = renderedHeadings(markup, 2);
    markFullTextAnchors(document, headings);
    assert.equal(headings[0]!.dataset.assistantSectionStart, undefined);
    assert.equal(headings[1]!.dataset.assistantSectionStart, document.sections[1]!.id);
  } finally {
    clearAssistantSectionReadingScope(scopeKey);
  }
});

test("other-depth HTML headings retain pagination and cannot steal a Markdown section anchor", () => {
  const markdown = "<h3>One</h3>\n\n## One\n\nfirst\n\n## Two\n\nsecond";
  const document = buildAssistantSectionDocument(markdown);
  assert.ok(document);
  const headings = renderedHeadings(renderMarkdown(markdown), 2);

  markFullTextAnchors(document, headings);

  assert.deepEqual(
    headings.map((heading) => heading.dataset.assistantSectionStart),
    document.sections.filter((section) => section.title).map((section) => section.id),
  );
});
