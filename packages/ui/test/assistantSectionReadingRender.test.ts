import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { buildAssistantSectionDocument } from "../src/lib/assistantSectionReading.js";
import {
  clearAssistantSectionReadingScope,
  createAssistantSectionReadingRowKey,
  markAssistantSectionRowPresented,
  revealAssistantReadingRowForSearch,
  selectAssistantReadingSection,
} from "../src/store/assistantSectionReadingStore.js";
import { AssistantSectionReading } from "../src/v4/AssistantSectionReading.js";

const markdown = "Intro\n\n## First section\n\nFirst body\n\n## Second section\n\nHidden body";

function renderReader(
  source: string,
  options: {
    scopeKey: string;
    full?: boolean;
    presentedDuringRun?: boolean;
    sectionIndex?: number;
    withDocument?: boolean;
  },
): string {
  const document =
    options.withDocument === false ? undefined : buildAssistantSectionDocument(source);
  if (options.withDocument !== false) assert.ok(document);
  try {
    const rowKey = createAssistantSectionReadingRowKey({ turnId: "turn-23", rowId: 23 });
    if (options.presentedDuringRun) markAssistantSectionRowPresented(options.scopeKey, rowKey);
    if (options.full) {
      revealAssistantReadingRowForSearch(options.scopeKey, rowKey);
    }
    if (options.sectionIndex !== undefined) {
      assert.ok(document);
      selectAssistantReadingSection({
        scopeKey: options.scopeKey,
        rowKey,
        rowId: 23,
        sectionId: document.sections[options.sectionIndex]!.id,
        version: document.version,
      });
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

function taggedButton(markup: string, attribute: string): string {
  const match = markup.match(new RegExp(`<button\\b[^>]*${attribute}[^>]*>`));
  assert.ok(match, `${attribute} 按钮存在`);
  return match[0];
}

function headerMarkup(markup: string): string {
  const start = markup.indexOf("data-assistant-section-header");
  const end = markup.indexOf("data-conversation-selectable");
  assert.ok(start >= 0 && start < end);
  return markup.slice(start, end);
}

test("cold completed response renders one card with a single compact sticky header", () => {
  const markup = renderReader(markdown, { scopeKey: "assistant-reading-layout-cold" });
  const origin = markup.indexOf("data-assistant-section-origin");
  const card = markup.indexOf("data-assistant-section-card");
  const header = markup.indexOf("data-assistant-section-header");
  const body = markup.indexOf("data-conversation-selectable");

  assert.ok(origin >= 0 && origin < card && card < header && header < body);
  const cardMarkup = markup.slice(card, header);
  assert.match(cardMarkup, /bg-card/);
  assert.match(cardMarkup, /border-card-border/);
  assert.match(cardMarkup, /shadow-sm/);
  assert.match(cardMarkup, /rounded-xl/);
  assert.match(cardMarkup, /@container\/assistant-reading/);
  assert.match(cardMarkup, /focus:outline-none/);
  assert.match(
    markup,
    /min-h-\[clamp\(160px,40dvh,320px\)\].*sm:min-h-\[clamp\(220px,46dvh,480px\)\]/,
  );
  assert.match(markup, /top:calc\(56px - var\(--timeline-virtual-row-offset, 0px\)\)/);

  const headerMarkupText = headerMarkup(markup);
  assert.match(headerMarkupText, /sticky/);
  assert.match(headerMarkupText, /导语/);
  assert.match(headerMarkupText, /1\s*\/\s*3/);
  assert.match(headerMarkupText, /目录/);
  assert.match(headerMarkupText, /上一节/);
  assert.match(headerMarkupText, /下一节/);
  assert.match(headerMarkupText, /全文/);
  assert.match(headerMarkupText, /第 1 节，共 3 节/);
  assert.match(headerMarkupText, /@min-\[640px\]\/assistant-reading:inline/);
  assert.doesNotMatch(headerMarkupText, /\bsm:inline\b/);
  assert.match(headerMarkupText, /focus-visible:bg-hover/);
  assert.match(
    taggedButton(markup, "data-assistant-section-full"),
    /\[@media\(pointer:coarse\)\]:min-w-11/,
  );
  assert.doesNotMatch(markup, /data-assistant-section-nav|data-assistant-section-pagination/);
  assert.doesNotMatch(markup, /role="tablist"|role="tab"/);
  assert.doesNotMatch(markup, /data-assistant-section-footer/);

  assert.match(taggedButton(markup, "data-assistant-section-previous"), /\bdisabled=/);
  assert.doesNotMatch(taggedButton(markup, "data-assistant-section-next"), /\bdisabled=/);
  assert.match(markup.slice(body), /Intro/);
  assert.doesNotMatch(markup, /Hidden body/);
});

test("full reading drops the card shell and keeps only the lightweight card entry", () => {
  const markup = renderReader(markdown, { scopeKey: "assistant-reading-layout-full", full: true });
  const entry = markup.indexOf("data-assistant-section-entry");
  const body = markup.indexOf("data-conversation-selectable");

  assert.ok(entry >= 0 && entry < body);
  assert.doesNotMatch(
    markup,
    /data-assistant-section-card|data-assistant-section-header|data-assistant-section-toc-trigger|data-assistant-section-previous|data-assistant-section-next|data-assistant-section-full/,
  );
  assert.match(markup.slice(entry, body), /卡片阅读/);
  assert.match(markup.slice(entry, body), /focus-visible:bg-hover/);
  assert.doesNotMatch(markup.slice(entry, body), /\bsticky\b/);
  assert.match(markup.slice(body), /First body/);
  assert.match(markup.slice(body), /Hidden body/);
  assert.doesNotMatch(markup, /data-assistant-section-footer/);
});

test("a response presented during streaming completes continuously with only the card entry", () => {
  const markup = renderReader(markdown, {
    scopeKey: "assistant-reading-layout-live-complete",
    presentedDuringRun: true,
  });
  const entry = markup.indexOf("data-assistant-section-entry");
  const body = markup.indexOf("data-conversation-selectable");

  assert.ok(entry >= 0 && entry < body);
  assert.match(markup.slice(entry, body), /卡片阅读/);
  assert.doesNotMatch(markup, /data-assistant-section-card|data-assistant-section-header/);
  assert.match(markup.slice(body), /First body/);
  assert.match(markup.slice(body), /Hidden body/);
});

test("last-section card keeps both navigation entries and only disables next", () => {
  const markup = renderReader(markdown, {
    scopeKey: "assistant-reading-layout-last",
    sectionIndex: 2,
  });
  assert.match(headerMarkup(markup), /3\s*\/\s*3/);
  assert.doesNotMatch(taggedButton(markup, "data-assistant-section-previous"), /\bdisabled=/);
  assert.match(taggedButton(markup, "data-assistant-section-next"), /\bdisabled=/);
  assert.match(markup.slice(markup.indexOf("data-conversation-selectable")), /Hidden body/);
});

test("long section titles keep their full text and use local scrolling instead of truncation", () => {
  const title = "当标题包含一整句说明和多个模型名称时仍然保留完整内容并通过章节栏横向滚动阅读";
  const markup = renderReader(`## ${title}\n\nfirst\n\n## Another section\n\nsecond`, {
    scopeKey: "assistant-reading-layout-long-title",
  });
  const header = headerMarkup(markup);

  assert.ok(header.includes(title));
  assert.match(header, /whitespace-nowrap/);
  assert.match(header, /overflow-hidden|overflow-y-hidden|overflow-x-auto/);
  assert.doesNotMatch(header, /\btruncate\b|max-w-56/);
});

test("narrow-screen header keeps accessible icon navigation and touch targets", () => {
  const markup = renderReader(markdown, { scopeKey: "assistant-reading-layout-narrow" });
  const header = headerMarkup(markup);

  assert.match(header, /title="上一节"/);
  assert.match(header, /aria-label="上一节"/);
  assert.match(header, /title="下一节"/);
  assert.match(header, /aria-label="下一节"/);
  assert.match(header, /aria-label="目录"/);
  assert.match(header, /hidden @min-\[640px\]\/assistant-reading:inline/);
  assert.doesNotMatch(header, /\bsm:inline\b/);
  assert.match(header, /\[@media\(pointer:coarse\)\]:min-h-11/);
  assert.match(header, /\[@media\(pointer:coarse\)\]:min-w-11/);
  assert.match(header, /focus-visible:bg-hover/);
  assert.match(header, /tabular-nums/);
});

test("short plain sections use the optional text emphasis without scaling structured content", () => {
  const plain = renderReader("## A\n\nHi\n\n## B\n\nBye", {
    scopeKey: "assistant-reading-layout-plain-emphasis",
  });
  const plainBody = plain.slice(plain.indexOf("data-conversation-selectable"));
  assert.match(plainBody, /data-assistant-section-emphasis="xl"/);
  assert.match(plainBody, /\[&amp;_p\]:text-ui-xl/);
  assert.doesNotMatch(plain, /scale-|transform/);

  const structured = renderReader("## A\n\n```\ncode\n```\n\n## B\n\nBye", {
    scopeKey: "assistant-reading-layout-structured-emphasis",
  });
  const structuredBody = structured.slice(structured.indexOf("data-conversation-selectable"));
  assert.doesNotMatch(structuredBody, /data-assistant-section-emphasis/);
  assert.doesNotMatch(structuredBody, /\[&amp;_p\]:text-ui-(lg|xl)/);
});

test("a response without a section document keeps its original body and has no reading controls", () => {
  const markup = renderReader("An answer without headings.", {
    scopeKey: "assistant-reading-layout-no-headings",
    withDocument: false,
  });

  assert.match(markup, /An answer without headings\./);
  assert.doesNotMatch(
    markup,
    /data-assistant-section-card|data-assistant-section-header|data-assistant-section-entry|data-assistant-section-toc-trigger|data-assistant-section-origin/,
  );
  assert.doesNotMatch(markup, /上一节|下一节|卡片阅读|全文|目录/);
});

test("interactive rules keep the card click guard and the directory on existing menu primitives", async () => {
  const [readerSource, navigationSource] = await Promise.all([
    readFile(new URL("../src/v4/AssistantSectionReading.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/v4/AssistantSectionReadingNavigation.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(readerSource, /event\.target === event\.currentTarget/);
  assert.doesNotMatch(readerSource, /scrollIntoView|scrollTop\s*=/);
  assert.match(readerSource, /data-assistant-section-content/);
  assert.match(readerSource, /\[data-assistant-section-toc\], \[role='menu'\]/);
  assert.match(readerSource, /onPointerDownCapture/);
  assert.match(readerSource, /selectionCollapsedAtPointerDown/);
  assert.match(readerSource, /@container\/assistant-reading/);
  assert.match(navigationSource, /DropdownMenuContent/);
  assert.match(navigationSource, /aria-current=/);
  assert.match(navigationSource, /whitespace-normal/);
  assert.match(navigationSource, /onCloseAutoFocus/);
  assert.match(
    navigationSource,
    /data-assistant-section-toc-item[\s\S]{0,400}\[@media\(pointer:coarse\)\]:min-h-11/,
  );
  assert.match(
    navigationSource,
    /data-assistant-section-full[\s\S]{0,300}className=\{controlClassName\}/,
  );
  assert.match(navigationSource, /const controlClassName =[\s\S]{0,300}min-w-11/);
});
