import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { FilesWorkbenchMenuBar } from "../src/files-workbench/FilesWorkbenchMenuBar.js";

function renderMenu(locale: Locale, isActiveView = true): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(FilesWorkbenchMenuBar, {
        state: { hasActiveEditor: false, canSave: false, dirtyFileCount: 0 },
        canEdit: false,
        canCreateFile: true,
        onCommand: () => undefined,
        onCloseEditor: () => undefined,
        shortcutLabels: {},
        isActiveView,
      }),
    ),
  );
}

test("Web 空文件工作台提供文件与编辑两个可点击菜单入口并填满48px导航行", () => {
  const markup = renderMenu("zh-CN");
  assert.equal(markup.match(/aria-haspopup="menu"/g)?.length, 2);
  assert.match(markup, />文件<\/button>/);
  assert.match(markup, />编辑<\/button>/);
  assert.match(markup, /class="flex h-full min-w-0 flex-1 items-center/);
  assert.doesNotMatch(markup, /\bh-9\b|border-b/);
  assert.match(markup, /app-region:no-drag/);
});

test("菜单标题沿用应用当前语言", () => {
  const markup = renderMenu("en-US");
  assert.match(markup, />File<\/button>/);
  assert.match(markup, />Edit<\/button>/);
});

test("文件视图保活但不可见时不渲染菜单入口", () => {
  assert.equal(renderMenu("zh-CN", false), "");
});
