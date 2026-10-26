import assert from "node:assert/strict";
import test from "node:test";
import { buildAssistantSectionDocument } from "../src/lib/assistantSectionReading.js";
import {
  cancelAssistantSectionNavigation,
  clearAssistantSectionReadingScope,
  createAssistantSectionReadingRowKey,
  getAssistantSectionReadingPendingNavigation,
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

test("falls back when same-depth HTML headings make full-text section anchors ambiguous", () => {
  const document = buildAssistantSectionDocument(
    "```md\n## Code\n```\n\n> ## Quote\n\n- ## List\n\n<h2>HTML</h2>\n\n## Actual one\n\na\n\n## Actual two\n\nb",
  );
  assert.equal(document, undefined);
});

test("does not split heading-like content in code, quotes, lists or other-depth HTML", () => {
  const document = buildAssistantSectionDocument(
    "```md\n## Code\n<h2>Code HTML</h2>\n```\n\n> ## Quote\n\n- ## List\n\n<h3>HTML</h3>\n\n## Actual one\n\na\n\n## Actual two\n\nb",
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
    "<!-- generated <h2>metadata</h2> -->\n<!-- metadata -->\n\n## One\n\na\n\n## Two\n\nb",
  );
  assert.ok(document);
  assert.equal(document.sections.length, 2);
});

test("keeps visible comment text inside a code example on its page", () => {
  const markdown = "    <!-- visible code example -->\n\n## One\n\na\n\n## Two\n\nb";
  const document = buildAssistantSectionDocument(markdown);

  assert.ok(document);
  assert.equal(document.sections.length, 3);
  assert.match(document.sections[0]!.markdown, /<!-- visible code example -->/);
});

test("decodes HTML entities in section titles and falls back for answers without repeated headings", () => {
  const document = buildAssistantSectionDocument("## A &amp; B\n\nfirst\n\n## Next\n\nsecond");
  assert.ok(document);
  assert.deepEqual(
    document.sections.map((section) => section.title),
    ["A & B", "Next"],
  );
  assert.equal(buildAssistantSectionDocument("A long answer without headings."), undefined);
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

test("a newer section navigation supersedes requests from every other row", () => {
  const scopeKey = `assistant-reading-latest-navigation-${Math.random()}`;
  const firstRowKey = createAssistantSectionReadingRowKey({ turnId: "turn-first", rowId: 31 });
  const secondRowKey = createAssistantSectionReadingRowKey({ turnId: "turn-second", rowId: 32 });
  try {
    selectAssistantReadingSection({
      scopeKey,
      rowKey: firstRowKey,
      rowId: 31,
      sectionId: "first-section",
      version: "first-version",
    });
    const latest = selectAssistantReadingSection({
      scopeKey,
      rowKey: secondRowKey,
      rowId: 32,
      sectionId: "second-section",
      version: "second-version",
    });

    assert.equal(getAssistantSectionReadingPendingNavigation(scopeKey)?.rowKey, secondRowKey);
    assert.ok(latest.pendingScroll);
    settleAssistantSectionNavigation(scopeKey, secondRowKey, latest.pendingScroll!.requestId);
    assert.equal(getAssistantSectionReadingPendingNavigation(scopeKey), undefined);
  } finally {
    clearAssistantSectionReadingScope(scopeKey);
  }
});

test("merges a solitary total title into the first split section instead of an empty intro page", () => {
  const markdown = "# 总标题\n\n## 第一节\n\n正文\n\n### 细节\n\n嵌套内容\n\n## 第二节\n\n更多";
  const document = buildAssistantSectionDocument(markdown);

  assert.ok(document);
  assert.equal(document.splitHeadingDepth, 2);
  assert.deepEqual(
    document.sections.map((section) => section.title),
    ["第一节", "第二节"],
  );
  assert.equal(document.sections[0]!.startOffset, 0);
  assert.match(document.sections[0]!.markdown, /^# 总标题/);
  assert.match(document.sections[0]!.markdown, /### 细节/);
  assert.doesNotMatch(document.sections[0]!.markdown, /## 第二节/);
  // 合并前缀后不丢任何原始 token，后一节仍从原标题位置开始。
  assert.equal(document.sections[0]!.markdown + document.sections[1]!.markdown, markdown);
  assert.equal(document.sections[1]!.startOffset, markdown.indexOf("## 第二节"));
});

test("keeps a real lead-in as an intro page while preserving the total title", () => {
  const markdown = "# 总标题\n\n真实导语\n\n## 第一节\n\na\n\n## 第二节\n\nb";
  const document = buildAssistantSectionDocument(markdown);

  assert.ok(document);
  assert.deepEqual(
    document.sections.map((section) => section.title),
    ["", "第一节", "第二节"],
  );
  assert.equal(document.sections[0]!.startOffset, 0);
  assert.match(document.sections[0]!.markdown, /^# 总标题/);
  assert.match(document.sections[0]!.markdown, /真实导语/);
  assert.doesNotMatch(document.sections[0]!.markdown, /## 第一节/);
  assert.equal(document.sections[1]!.startOffset, markdown.indexOf("## 第一节"));
  const lastSection = document.sections.at(-1)!;
  assert.equal(markdown.slice(lastSection.startOffset), lastSection.markdown);
});

test("treats comments and reference definitions around a total title as invisible prefix", () => {
  const markdown =
    "<!-- 生成元数据 -->\n\n[shared]: https://example.com\n\n# 总标题\n\n<!-- 尾部注释 -->\n\n## 第一节\n\na\n\n## 第二节\n\nb";
  const document = buildAssistantSectionDocument(markdown);

  assert.ok(document);
  assert.deepEqual(
    document.sections.map((section) => section.title),
    ["第一节", "第二节"],
  );
  assert.equal(document.sections[0]!.startOffset, 0);
  assert.match(document.sections[0]!.markdown, /# 总标题/);
  assert.match(document.sections[0]!.markdown, /\[shared\]: https:\/\/example.com/);
});

test("keeps an intro page when the prefix has another heading, body or structured content", () => {
  const nested = buildAssistantSectionDocument(
    "# 总标题\n\n### 更深的标题\n\n## 第一节\n\na\n\n## 第二节\n\nb",
  );
  assert.ok(nested);
  assert.deepEqual(
    nested.sections.map((section) => section.title),
    ["", "第一节", "第二节"],
  );

  const code = buildAssistantSectionDocument(
    "# 总标题\n\n```ts\nconst value = 1;\n```\n\n## 第一节\n\na\n\n## 第二节\n\nb",
  );
  assert.ok(code);
  assert.deepEqual(
    code.sections.map((section) => section.title),
    ["", "第一节", "第二节"],
  );
});

test("keeps duplicate headings addressable after merging a total title", () => {
  const document = buildAssistantSectionDocument("# 总标题\n\n## 重复\n\na\n\n## 重复\n\nb");

  assert.ok(document);
  assert.equal(document.sections.length, 2);
  assert.equal(document.sections[0]!.title, document.sections[1]!.title);
  assert.notEqual(document.sections[0]!.id, document.sections[1]!.id);
  assert.equal(document.sections[0]!.startOffset, 0);
});

test("a total title prefix does not weaken existing full-text fallbacks", () => {
  assert.equal(
    buildAssistantSectionDocument("# 总标题\n\n<h2>HTML</h2>\n\n## 一\n\na\n\n## 二\n\nb"),
    undefined,
  );
  assert.equal(
    buildAssistantSectionDocument("# 总标题\n\n## 一\n\na\n\n## 二\n\n[跳转](#一)"),
    undefined,
  );
  assert.equal(
    buildAssistantSectionDocument("# 总标题\n\n## 一\n\n[^note]\n\n## 二\n\n[^note]: 注释"),
    undefined,
  );
});

test("marks only short plain sections for optional text emphasis", () => {
  const markdown = [
    "## 极短",
    "",
    "完成。",
    "",
    "## 较短",
    "",
    "a".repeat(60),
    "",
    "## 结构",
    "",
    "- 列表项",
    "",
    "## 长文",
    "",
    "b".repeat(140),
    "",
    "## 仅标题",
    "",
    "## 下一节",
    "",
    "c",
  ].join("\n");
  const document = buildAssistantSectionDocument(markdown);

  assert.ok(document);
  const byTitle = new Map(document.sections.map((section) => [section.title, section]));
  assert.equal(byTitle.get("极短")!.presentation?.emphasis, "xl");
  assert.equal(byTitle.get("较短")!.presentation?.emphasis, "lg");
  assert.equal(byTitle.get("结构")!.presentation, undefined);
  assert.equal(byTitle.get("长文")!.presentation, undefined);
  assert.equal(byTitle.get("仅标题")!.presentation?.emphasis, "xl");
  assert.equal(byTitle.get("下一节")!.presentation?.emphasis, "xl");
});

test("does not emphasize structured content even when it is very short", () => {
  const document = buildAssistantSectionDocument(
    "## 代码\n\n```\nx\n```\n\n## 表格\n\n| a |\n| - |\n| 1 |\n\n## 引用\n\n> q\n\n## 图片\n\n![alt](x.png)\n\n## 纯文字\n\nok",
  );

  assert.ok(document);
  for (const section of document.sections) {
    if (section.title === "纯文字") continue;
    assert.equal(section.presentation, undefined, `${section.title} 不应被强调`);
  }
  assert.equal(document.sections.at(-1)!.presentation?.emphasis, "xl");
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
