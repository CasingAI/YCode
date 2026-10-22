import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { buildAssistantSectionDocument } from "../src/lib/assistantSectionReading.js";
import { AssistantSectionReading } from "../src/v4/AssistantSectionReading.js";

test("cold completed response renders only the introduction page and keeps controls outside selection", () => {
  const markdown = "Intro\n\n## First section\n\nFirst body\n\n## Second section\n\nHidden body";
  const document = buildAssistantSectionDocument(markdown);
  assert.ok(document);
  const markup = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(AssistantSectionReading, {
        rowId: 23,
        turnId: "turn-23",
        scopeKey: "assistant-reading-render-test",
        document,
        markdown,
        turnRunning: false,
        renderMarkdown: (page) => createElement("div", null, page),
      }),
    ),
  );

  assert.match(markup, /data-assistant-section-nav="23"/);
  assert.match(markup, /回答章节/);
  assert.match(markup, /Intro/);
  assert.doesNotMatch(markup, /Hidden body/);
  assert.ok(
    markup.indexOf("data-assistant-section-nav") < markup.indexOf("data-conversation-selectable"),
  );
});
