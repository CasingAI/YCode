import assert from "node:assert/strict";
import test from "node:test";
import { buildAssistantSectionDocument } from "../src/lib/assistantSectionReading.js";
import {
  cancelAssistantSectionNavigation,
  clearAssistantSectionReadingScope,
  createAssistantSectionReadingRowKey,
  initializeAssistantSectionReading,
  markAssistantSectionRowPresented,
  revealAssistantReadingRowForSearch,
  selectAssistantReadingSection,
  settleAssistantSectionNavigation,
  setAssistantReadingMode,
  subscribeAssistantSectionReadingRow,
  subscribeAssistantSectionReadingScope,
  wasAssistantSectionRowPresented,
} from "../src/store/assistantSectionReadingStore.js";

test("splits by the shallowest repeated root heading and keeps an introduction page", () => {
  const document = buildAssistantSectionDocument(
    "Intro text\n\n# Report\n\n## Findings\n\nText\n\n### Detail\n\nNested\n\n## Next\n\nMore",
  );

  assert.ok(document);
  assert.equal(document.splitHeadingDepth, 2);
  assert.deepEqual(
    document.sections.map((section) => section.title),
    ["", "Findings", "Next"],
  );
  assert.match(document.sections[0]!.markdown, /Intro text/);
  assert.match(document.sections[1]!.markdown, /### Detail/);
  assert.doesNotMatch(document.sections[1]!.markdown, /## Next/);
});

test("uses repeated H3 headings when no shallower level repeats", () => {
  const document = buildAssistantSectionDocument("### One\n\na\n\n### Two\n\nb");
  assert.ok(document);
  assert.equal(document.splitHeadingDepth, 3);
  assert.deepEqual(
    document.sections.map((section) => section.title),
    ["One", "Two"],
  );
});

test("does not split heading-like content inside code, quotes, lists or HTML", () => {
  const document = buildAssistantSectionDocument(
    "```md\n## Code\n```\n\n> ## Quote\n\n- ## List\n\n<h2>HTML</h2>\n\n## Actual one\n\na\n\n## Actual two\n\nb",
  );
  assert.ok(document);
  assert.deepEqual(
    document.sections.map((section) => section.title),
    ["", "Actual one", "Actual two"],
  );
  assert.match(document.sections[0]!.markdown, /> ## Quote/);
});

test("does not create an introduction page for blank space and reference definitions", () => {
  const document = buildAssistantSectionDocument(
    "\n\n[shared]: https://example.com\n\n## One\n\na\n\n## Two\n\nb",
  );
  assert.ok(document);
  assert.equal(document.sections.length, 2);
  assert.match(document.sections[0]!.markdown, /\[shared\]: https:\/\/example.com/);
  assert.match(document.sections[1]!.markdown, /\[shared\]: https:\/\/example.com/);
});

test("does not create an introduction page for HTML comments", () => {
  const document = buildAssistantSectionDocument(
    "<!-- generated -->\n<!-- metadata -->\n\n## One\n\na\n\n## Two\n\nb",
  );
  assert.ok(document);
  assert.equal(document.sections.length, 2);
});

test("falls back to continuous rendering when page parsing could break local links or footnotes", () => {
  assert.equal(buildAssistantSectionDocument("## One\n\na\n\n## Two\n\n[go](#two)"), undefined);
  assert.equal(
    buildAssistantSectionDocument("## One\n\n[^note]\n\n## Two\n\n[^note]: note"),
    undefined,
  );
  assert.equal(buildAssistantSectionDocument("## Only one\n\nbody"), undefined);
});

test("keeps duplicate titles addressable by source position", () => {
  const document = buildAssistantSectionDocument("## Repeat\n\na\n\n## Repeat\n\nb");
  assert.ok(document);
  assert.equal(document.sections[0]!.title, document.sections[1]!.title);
  assert.notEqual(document.sections[0]!.id, document.sections[1]!.id);
});

test("tracks presentation, page selection, search reveal and stale navigation", () => {
  const scopeKey = `assistant-reading-test-${Math.random()}`;
  const rowKey = createAssistantSectionReadingRowKey({ turnId: "turn-a", rowId: 42 });
  try {
    markAssistantSectionRowPresented(scopeKey, rowKey);
    assert.equal(wasAssistantSectionRowPresented(scopeKey, rowKey), true);
    assert.equal(
      initializeAssistantSectionReading({
        scopeKey,
        rowKey,
        rowId: 42,
        version: "v1",
        firstSectionId: "one",
      }).mode,
      "continuous",
    );

    const selected = selectAssistantReadingSection({
      scopeKey,
      rowKey,
      rowId: 42,
      sectionId: "two",
      version: "v1",
    });
    assert.equal(selected.mode, "paged");
    assert.ok(selected.pendingScroll);
    assert.equal(revealAssistantReadingRowForSearch(scopeKey, rowKey), false);
    assert.equal(
      initializeAssistantSectionReading({
        scopeKey,
        rowKey,
        rowId: 42,
        version: "v1",
        firstSectionId: "one",
      }).mode,
      "full",
    );

    selectAssistantReadingSection({
      scopeKey,
      rowKey,
      rowId: 42,
      sectionId: "one",
      version: "v1",
    });
    cancelAssistantSectionNavigation(scopeKey);
    const changed = initializeAssistantSectionReading({
      scopeKey,
      rowKey,
      rowId: 42,
      version: "v2",
      firstSectionId: "new-one",
    });
    assert.equal(changed.mode, "full");
    assert.equal(changed.pendingScroll, null);
    settleAssistantSectionNavigation(scopeKey, rowKey, 999);
    assert.equal(wasAssistantSectionRowPresented(scopeKey, rowKey), true);
  } finally {
    clearAssistantSectionReadingScope(scopeKey);
  }
});

test("a completed answer first seen outside the active view starts at the first page", () => {
  const scopeKey = `assistant-reading-cold-${Math.random()}`;
  const rowKey = createAssistantSectionReadingRowKey({ turnId: "turn-b", rowId: 7 });
  try {
    assert.equal(
      initializeAssistantSectionReading({
        scopeKey,
        rowKey,
        rowId: 7,
        version: "v1",
        firstSectionId: "intro",
      }).mode,
      "paged",
    );
  } finally {
    clearAssistantSectionReadingScope(scopeKey);
  }
});

test("expanding a page requests restoration of the active section viewport anchor", () => {
  const scopeKey = `assistant-reading-expand-${Math.random()}`;
  const rowKey = createAssistantSectionReadingRowKey({ turnId: "turn-expand", rowId: 19 });
  try {
    initializeAssistantSectionReading({
      scopeKey,
      rowKey,
      rowId: 19,
      version: "v1",
      firstSectionId: "section-one",
    });
    setAssistantReadingMode({
      scopeKey,
      rowKey,
      rowId: 19,
      mode: "full",
      version: "v1",
      anchorOffset: 96,
    });

    const state = initializeAssistantSectionReading({
      scopeKey,
      rowKey,
      rowId: 19,
      version: "v1",
      firstSectionId: "section-one",
    });
    assert.equal(state.mode, "full");
    assert.equal(state.pendingScroll?.sectionId, "section-one");
    assert.equal(state.pendingScroll?.anchorOffset, 96);
  } finally {
    clearAssistantSectionReadingScope(scopeKey);
  }
});

test("notifies only the changed row while timeline subscribers track navigation", () => {
  const scopeKey = `assistant-reading-subscribers-${Math.random()}`;
  const firstRowKey = createAssistantSectionReadingRowKey({ turnId: "turn-c", rowId: 1 });
  const secondRowKey = createAssistantSectionReadingRowKey({ turnId: "turn-d", rowId: 2 });
  let scopeNotifications = 0;
  let firstRowNotifications = 0;
  let secondRowNotifications = 0;
  const unsubscribeScope = subscribeAssistantSectionReadingScope(scopeKey, () => {
    scopeNotifications += 1;
  });
  const unsubscribeFirst = subscribeAssistantSectionReadingRow(scopeKey, firstRowKey, () => {
    firstRowNotifications += 1;
  });
  const unsubscribeSecond = subscribeAssistantSectionReadingRow(scopeKey, secondRowKey, () => {
    secondRowNotifications += 1;
  });

  try {
    markAssistantSectionRowPresented(scopeKey, firstRowKey);
    assert.deepEqual(
      [scopeNotifications, firstRowNotifications, secondRowNotifications],
      [0, 1, 0],
    );

    initializeAssistantSectionReading({
      scopeKey,
      rowKey: secondRowKey,
      rowId: 2,
      version: "v1",
      firstSectionId: "one",
    });
    assert.deepEqual(
      [scopeNotifications, firstRowNotifications, secondRowNotifications],
      [0, 1, 1],
    );

    selectAssistantReadingSection({
      scopeKey,
      rowKey: firstRowKey,
      rowId: 1,
      sectionId: "two",
      version: "v1",
    });
    assert.deepEqual(
      [scopeNotifications, firstRowNotifications, secondRowNotifications],
      [1, 2, 1],
    );
  } finally {
    unsubscribeFirst();
    unsubscribeSecond();
    unsubscribeScope();
    clearAssistantSectionReadingScope(scopeKey);
  }
});
