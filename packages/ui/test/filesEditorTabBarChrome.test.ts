import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { FilesEditorTabBar } from "../src/files-workbench/FilesEditorTabBar.js";
import type { FilesEditorTabEntry } from "../src/files-workbench/filesEditorTabAnimation.js";

function createTab(viewId: string, dirty = false): FilesEditorTabEntry {
  return {
    viewId,
    buffer: {
      id: `buffer:${viewId}`,
      kind: "text",
      untitled: false,
      path: `/workspace/${viewId}.ts`,
      title: `${viewId}.ts`,
      text: dirty ? "changed" : "saved",
      savedText: "saved",
      workspace: { workspacePath: "/workspace" },
    },
  };
}

function tabBarProps(
  groupId: string,
  tabs: readonly FilesEditorTabEntry[],
  activeViewId?: string,
): ComponentProps<typeof FilesEditorTabBar> {
  const noop = () => {};
  return {
    groupId,
    tabs,
    activeViewId,
    canCloseSaved: true,
    canRevealInFileTree: () => true,
    onActivate: noop,
    onKeepOpen: noop,
    onClose: noop,
    onCloseOthers: noop,
    onCloseToRight: noop,
    onCloseSaved: noop,
    onCloseAll: noop,
    onCopyPath: noop,
    onRevealInFileTree: noop,
    onSplit: noop,
    onMoveView: noop,
    onCreateUntitled: noop,
    onSave: noop,
    onSaveAs: noop,
  };
}

function renderBars(...groups: Array<ComponentProps<typeof FilesEditorTabBar>>): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      groups.map((props) => createElement(FilesEditorTabBar, { ...props, key: props.groupId })),
    ),
  );
}

function openingTags(markup: string, role: string): string[] {
  return Array.from(markup.matchAll(/<[^/!][^>]*>/g), (match) => match[0]).filter((tag) =>
    tag.includes(`role="${role}"`),
  );
}

function readWorkbenchSource(name: string): Promise<string> {
  return readFile(new URL(`../src/files-workbench/${name}`, import.meta.url), "utf8");
}

test("36px 标签条整体 no-drag，活动 Tab、关闭和保存/分屏按钮都在其内部", () => {
  const html = renderBars(tabBarProps("main", [createTab("active", true)], "active"));
  const tabList = openingTags(html, "tablist");
  assert.equal(tabList.length, 1);
  assert.match(tabList[0]!, /\bh-9\b/);
  assert.match(tabList[0]!, /\[app-region:no-drag\]/);
  assert.doesNotMatch(html, /\[app-region:drag\]/);
  assert.doesNotMatch(html, /\bh-12\b/);

  const tab = openingTags(html, "tab");
  assert.equal(tab.length, 1);
  assert.match(tab[0]!, /aria-selected="true"/);
  assert.match(tab[0]!, /data-editor-view-id="active"/);
  const tabListStart = html.indexOf(tabList[0]!);
  const controls = Array.from(html.matchAll(/<button\b[^>]*>/g));
  assert.equal(controls.length, 4, "活动脏 Tab 应有关闭、保存、向右分屏、向下分屏按钮");
  for (const control of controls) {
    assert.ok(control.index! > tabListStart);
  }
});

test("Electron no-drag 不取消文件 Tab 的原生 HTML 拖拽和独立选中状态", () => {
  const html = renderBars(tabBarProps("main", [createTab("first"), createTab("second")], "second"));
  const tabs = openingTags(html, "tab");
  assert.equal(tabs.length, 2);
  assert.match(tabs[0]!, /aria-selected="false"/);
  assert.match(tabs[1]!, /aria-selected="true"/);
  for (const tab of tabs) {
    assert.match(tab, /draggable="true"/);
    assert.match(tab, /tabindex="0"/);
  }
  assert.doesNotMatch(html, /\[app-region:drag\]/);
});

test("标签条消费每组局部避让变量，不把窗口拖动语义带进Tab", () => {
  const html = renderBars(tabBarProps("main", [createTab("active")], "active"));
  const tabList = openingTags(html, "tablist")[0]!;
  for (const [property, variable, fallback] of [
    ["padding-left", "leading-inset", "0px"],
    ["padding-right", "trailing-inset", "0px"],
    ["padding-top", "top-inset", "0px"],
    ["height", "height", "36px"],
  ]) {
    assert.ok(tabList.includes(`${property}:var(--files-tabbar-${variable}, ${fallback})`));
  }
  assert.match(tabList, /\[app-region:no-drag\]/);
  assert.doesNotMatch(tabList, /\[app-region:drag\]/);
});

test("空编辑器组保留36px不可拖标签条且禁用分屏按钮", () => {
  const html = renderBars(tabBarProps("empty", []));
  assert.equal(openingTags(html, "tab").length, 0);
  const tabList = openingTags(html, "tablist");
  assert.equal(tabList.length, 1);
  assert.match(tabList[0]!, /\bh-9\b/);
  assert.match(tabList[0]!, /\[app-region:no-drag\]/);
  const buttons = Array.from(html.matchAll(/<button\b[^>]*>/g), (match) => match[0]);
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every((button) => button.includes('disabled=""')));
});

test("分屏只增加各组标签条，文件Surface不再添加整行标题或窗口拖动层", async () => {
  const html = renderBars(
    tabBarProps("left", [createTab("left")], "left"),
    tabBarProps("right", [createTab("right")], "right"),
  );
  assert.equal(openingTags(html, "tablist").length, 2);
  assert.equal(openingTags(html, "tab").length, 2);
  assert.doesNotMatch(html, /\bh-12\b|\[app-region:drag\]/);

  const [surface, group] = await Promise.all([
    readWorkbenchSource("FilesWorkbenchSurface.tsx"),
    readWorkbenchSource("FilesEditorGroupPane.tsx"),
  ]);
  assert.doesNotMatch(surface, /FilesWorkbenchCaption|\bh-12\b|\[app-region:drag\]/);
  assert.equal((surface.match(/<FilesWorkbenchHeader\b/g) ?? []).length, 1);
  assert.equal((surface.match(/<FilesWorkbenchWindowControls\b/g) ?? []).length, 1);
  assert.ok(
    surface.indexOf("<FilesWorkbenchHeader") < surface.indexOf("{renderLayoutNode(layout.root)}"),
  );
  assert.ok(
    surface.indexOf("<FilesWorkbenchWindowControls") <
      surface.indexOf("{renderLayoutNode(layout.root)}"),
  );
  assert.match(surface, /<\/FilesWorkbenchHeader>\s*<FilesWorkbenchWindowControls\b/);
  assert.doesNotMatch(group, /FilesWorkbenchCaption|FilesWorkbenchHeader|DesktopWindowControls/);
  assert.doesNotMatch(group, /\[app-region:drag\]/);
});

test("空组标签条的空白双击仍只调用新建，不接到窗口标题拖动区", async () => {
  const source = await readWorkbenchSource("FilesEditorTabBar.tsx");
  assert.match(
    source,
    /tabs\.length === 0\s*\?\s*\([\s\S]*?<div\b[^>]*onDoubleClick=\{\(\) => onCreateUntitled\?\.\(\)\}/,
  );
  assert.doesNotMatch(source, /FilesWorkbenchCaption|FilesWorkbenchHeader|\[app-region:drag\]/);
});

test("文件标签条不感知 Markdown 展示模式，模式切换留给文档 Header", async () => {
  const source = await readWorkbenchSource("FilesEditorTabBar.tsx");
  assert.doesNotMatch(
    source,
    /FilesEditorMarkdownModeSwitch|markdownViewMode|onSetMarkdownViewMode|data-files-markdown-mode/,
  );
});

test("Tab 激活、关闭和拖拽继续按 viewId 接线，关闭按钮阻止冒泡激活", async () => {
  const source = await readWorkbenchSource("FilesEditorTabItem.tsx");
  assert.match(source, /onClick=\{\(event\) => \{[\s\S]*?onActivate\(viewId\)/);
  assert.match(source, /onDoubleClick=\{\(\) => onKeepOpen\(buffer\.id\)\}/);
  assert.match(
    source,
    /<button\b[\s\S]*?onClick=\{\(event\) => \{\s*event\.stopPropagation\(\);\s*onClose\(buffer\.id, viewId\);/,
  );
  assert.match(
    source,
    /onAuxClick=\{\(event\) => \{[\s\S]*?event\.button !== 1[\s\S]*?onClose\(buffer\.id, viewId\);/,
  );
  assert.match(source, /setData\(FILES_EDITOR_VIEW_DRAG_MIME, viewId\)/);
  assert.doesNotMatch(source, /\[app-region:drag\]/);
});
