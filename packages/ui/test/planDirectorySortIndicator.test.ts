import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanDirectorySortIndicator } from "../src/app-shell/PlanDirectorySidePane.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

test("目录排序说明常驻但不可操作", () => {
  const html = renderToStaticMarkup(
    createElement(PlanDirectorySortIndicator, { label: "按时间排序" }),
  );
  assert.match(html, /data-testid="plan-directory-sort-indicator"/);
  assert.match(html, /data-plan-directory-sort="createdAt"/);
  assert.match(html, /按时间排序/);
  // 本次要锁住的产品契约：它是说明而不是控件，用户点它不会有任何反应。
  assert.match(html, /<button[^>]*disabled/);
  assert.doesNotMatch(html, /aria-disabled/);
});

test("目录排序说明在禁用态仍用 title 说明规则", () => {
  const html = renderToStaticMarkup(
    createElement(PlanDirectorySortIndicator, { label: "Sorted by time" }),
  );
  assert.match(html, /title="Sorted by time"/);
  assert.match(html, /<button[^>]*disabled/);
});

test("中英语言包都提供排序说明文案", () => {
  for (const messages of [zhCN, enUS]) {
    const value = messages["planDirectory.sortByTime"];
    assert.equal(typeof value, "string");
    assert.ok((value as string).trim().length > 0);
  }
});
