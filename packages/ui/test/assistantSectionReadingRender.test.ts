import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { buildAssistantSectionDocument } from "../src/lib/assistantSectionReading.js";
import {
  clearAssistantSectionReadingScope,
  createAssistantSectionReadingRowKey,
  revealAssistantReadingRowForSearch,
} from "../src/store/assistantSectionReadingStore.js";
import { AssistantSectionReading } from "../src/v4/AssistantSectionReading.js";

const markdown = "Intro\n\n## First section\n\nFirst body\n\n## Second section\n\nHidden body";

function renderReader(
  source: string,
  options: { scopeKey: string; full?: boolean; withDocument?: boolean },
): string {
  const document =
    options.withDocument === false ? undefined : buildAssistantSectionDocument(source);
  if (options.withDocument !== false) assert.ok(document);
  try {
    if (options.full) {
      revealAssistantReadingRowForSearch(
        options.scopeKey,
        createAssistantSectionReadingRowKey({ turnId: "turn-23", rowId: 23 }),
      );
    }
    return renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(AssistantSectionReading, {
          rowId: 23,
          turnId: "turn-23",
          scopeKey: options.scopeKey,
          document,
          markdown: source,
          streaming: false,
          turnRunning: false,
          renderMarkdown: (page) => createElement("div", null, page),
        }),
      ),
    );
  } finally {
    clearAssistantSectionReadingScope(options.scopeKey);
  }
}

test("cold completed response keeps mode, chapters, body and footer in the approved order", () => {
  const markup = renderReader(markdown, { scopeKey: "assistant-reading-layout-cold" });
  const origin = markup.indexOf("data-assistant-section-origin");
  const header = markup.indexOf("data-assistant-section-header");
  const navigation = markup.indexOf("data-assistant-section-nav");
  const body = markup.indexOf("data-conversation-selectable");
  const footer = markup.indexOf("data-assistant-section-footer");

  assert.ok(origin >= 0 && origin < header);
  assert.match(markup, /top:calc\(56px - var\(--timeline-virtual-row-offset, 0px\)\)/);
  assert.ok(header >= 0 && header < navigation);
  assert.ok(navigation < body && body < footer);
  const headerMarkup = markup.slice(header, navigation);
  const navigationMarkup = markup.slice(navigation, body);
  const bodyMarkup = markup.slice(body, footer);
  const footerMarkup = markup.slice(footer);

  assert.match(headerMarkup, /分节阅读/);
  assert.match(headerMarkup, /展开全文/);
  assert.doesNotMatch(headerMarkup, /上一节|下一节/);
  assert.match(navigationMarkup, /role="tablist"/);
  assert.doesNotMatch(navigationMarkup, /展开全文|上一节|下一节/);
  assert.match(footerMarkup, /上一节/);
  assert.match(footerMarkup, /下一节/);
  assert.match(footerMarkup, /1\s*\/\s*3/);
  assert.match(markup, /回答章节/);
  assert.match(bodyMarkup, /Intro/);
  assert.doesNotMatch(markup, /Hidden body/);
  assert.doesNotMatch(bodyMarkup, /展开全文|上一节|下一节/);
});

test("full reading keeps the separate header and chapter count and hides the paging footer", () => {
  const markup = renderReader(markdown, { scopeKey: "assistant-reading-layout-full", full: true });
  const header = markup.indexOf("data-assistant-section-header");
  const navigation = markup.indexOf("data-assistant-section-nav");
  const body = markup.indexOf("data-conversation-selectable");

  assert.ok(header >= 0 && header < navigation && navigation < body);
  assert.match(markup.slice(header, navigation), /连续阅读/);
  assert.match(markup.slice(header, navigation), /按章节阅读/);
  assert.match(markup.slice(navigation, body), /共\s*3\s*节/);
  assert.doesNotMatch(markup, /data-assistant-section-footer/);
  assert.match(markup.slice(body), /First body/);
  assert.match(markup.slice(body), /Hidden body/);
});

test("long section labels remain complete without individual truncation", () => {
  const title = "当标题包含一整句说明和多个模型名称时仍然保留完整内容并通过章节栏横向滚动阅读";
  const markup = renderReader(`## ${title}\n\nfirst\n\n## Another section\n\nsecond`, {
    scopeKey: "assistant-reading-layout-long-title",
  });
  const navigation = markup.slice(
    markup.indexOf("data-assistant-section-nav"),
    markup.indexOf("data-conversation-selectable"),
  );

  assert.ok(navigation.includes(title));
  assert.doesNotMatch(navigation, /\btruncate\b|max-w-56/);
});

test("a response without a section document keeps its original body and has no reading controls", () => {
  const markup = renderReader("An answer without headings.", {
    scopeKey: "assistant-reading-layout-no-headings",
    withDocument: false,
  });

  assert.match(markup, /An answer without headings\./);
  assert.doesNotMatch(markup, /data-assistant-section-nav|data-assistant-section-footer/);
  assert.doesNotMatch(markup, /role="tablist"|展开全文|上一节|下一节/);
});
