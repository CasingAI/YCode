import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FilesWorkbenchHeader } from "../src/files-workbench/FilesWorkbenchHeader.js";

test("Desktop不保留标题行、拖动行或页内菜单，标签可直接从工作台顶部开始", () => {
  let childMounts = 0;
  function MenuChild() {
    childMounts += 1;
    return createElement("button", null, "menu-sentinel");
  }
  for (const isActiveView of [true, false]) {
    const markup = renderToStaticMarkup(
      createElement(FilesWorkbenchHeader, {
        isDesktop: true,
        isActiveView,
        children: createElement(MenuChild),
      }),
    );
    assert.equal(markup, "");
  }
  assert.equal(childMounts, 0);
});

test("活跃Web只有一条48px导航行，页内菜单与全局按钮同排且始终不声明窗口drag", () => {
  const markup = renderToStaticMarkup(
    createElement(FilesWorkbenchHeader, {
      isDesktop: false,
      isActiveView: true,
      children: createElement("button", null, "menu-sentinel"),
    }),
  );
  assert.match(markup, /data-files-workbench-header=""/);
  assert.match(markup, /class="flex h-12 shrink-0 items-stretch/);
  assert.match(markup, /app-region:no-drag/);
  assert.match(markup, /padding-left:var\(--files-workbench-header-leading-inset, 0px\)/);
  assert.match(markup, /padding-right:var\(--files-workbench-header-trailing-inset, 0px\)/);
  assert.match(markup, /<button>menu-sentinel<\/button>/);
  assert.doesNotMatch(markup, /h-9/);
  assert.doesNotMatch(markup, /data-files-workbench-titlebar/);
  assert.doesNotMatch(markup, /aria-hidden="true"/);
  assert.doesNotMatch(markup, /\[app-region:drag\]/);
  assert.doesNotMatch(markup, /data-files-workbench-drag-region|window-controls/);
});

test("隐藏保活Web不挂载菜单或导航占位", () => {
  let childMounts = 0;
  function MenuChild() {
    childMounts += 1;
    return createElement("button", null, "hidden-menu-sentinel");
  }
  const markup = renderToStaticMarkup(
    createElement(FilesWorkbenchHeader, {
      isDesktop: false,
      isActiveView: false,
      children: createElement(MenuChild),
    }),
  );
  assert.equal(markup, "");
  assert.equal(childMounts, 0);
});
