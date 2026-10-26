import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  WorkspaceSidebarTaskSortMenu,
  WorkspaceSidebarTaskSortMenuContent,
  WorkspaceSidebarTaskViewMenu,
  WorkspaceSidebarTaskViewMenuContent,
} from "../src/WorkspaceSidebar/WorkspaceSidebarTaskViewMenus.js";

type ViewValue = "grouped" | "project" | "chronological";
type SortValue = "updated" | "created";

const VIEW_VALUES: ViewValue[] = ["grouped", "project", "chronological"];
const SORT_VALUES: SortValue[] = ["updated", "created"];

// 静态渲染不等于 DOM / E2E：桩只捕获回调，交互在 render 返回后由测试显式调用。
function StubLabel({ children }: { children?: ReactNode }) {
  return createElement("div", { "data-slot": "menu-label" }, children);
}

function StubRadioItem({ value, children }: { value: string; children?: ReactNode }) {
  return createElement("div", { "data-slot": "menu-radio-item", "data-value": value }, children);
}

interface CapturedRadioGroup {
  value?: string;
  onValueChange?: (value: string) => void;
}

function createRadioGroupStub(captured: CapturedRadioGroup) {
  return function StubRadioGroup({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children?: ReactNode;
  }) {
    captured.value = value;
    captured.onValueChange = onValueChange;
    return createElement("div", { "data-slot": "menu-radio-group", "data-value": value }, children);
  };
}

const echoIntl = {
  formatMessage: ({ id }: { id: string }) => id,
};

function renderViewContent(value: ViewValue): {
  markup: string;
  selected: string[];
  control: CapturedRadioGroup;
} {
  const selected: string[] = [];
  const control: CapturedRadioGroup = {};
  const markup = renderToStaticMarkup(
    createElement(WorkspaceSidebarTaskViewMenuContent, {
      intl: echoIntl,
      value,
      onValueChange: (nextValue: ViewValue) => selected.push(nextValue),
      Label: StubLabel,
      RadioGroup: createRadioGroupStub(control),
      RadioItem: StubRadioItem,
    }),
  );
  return { markup, selected, control };
}

function renderSortContent(value: SortValue): {
  markup: string;
  selected: string[];
  control: CapturedRadioGroup;
} {
  const selected: string[] = [];
  const control: CapturedRadioGroup = {};
  const markup = renderToStaticMarkup(
    createElement(WorkspaceSidebarTaskSortMenuContent, {
      intl: echoIntl,
      value,
      onValueChange: (nextValue: SortValue) => selected.push(nextValue),
      Label: StubLabel,
      RadioGroup: createRadioGroupStub(control),
      RadioItem: StubRadioItem,
    }),
  );
  return { markup, selected, control };
}

function assertOrdered(markup: string, values: string[]) {
  let previousIndex = -1;
  for (const value of values) {
    const index = markup.indexOf(`data-slot="menu-radio-item" data-value="${value}"`);
    assert.notEqual(index, -1, `菜单缺少 ${value}`);
    assert.ok(index > previousIndex, `菜单项 ${value} 顺序不正确`);
    previousIndex = index;
  }
}

test("视图菜单按分组 / 项目 / 时间线顺序渲染，回传选择值并忽略非法值", () => {
  const { markup, selected, control } = renderViewContent("project");

  assertOrdered(markup, VIEW_VALUES);
  assert.match(markup, /workspaceSidebar\.organize/);
  assert.match(markup, /workspaceSidebar\.organizeGrouped/);
  assert.match(markup, /workspaceSidebar\.organizeByProject/);
  assert.match(markup, /workspaceSidebar\.organizeChronologicalList/);
  assert.doesNotMatch(markup, /workspaceSidebar\.viewByWorkspace/);
  assert.doesNotMatch(markup, /workspaceSidebar\.sortBy/);

  const onValueChange = control.onValueChange;
  assert.ok(onValueChange);
  onValueChange("grouped");
  onValueChange("project");
  onValueChange("chronological");
  assert.deepEqual(selected, VIEW_VALUES);

  onValueChange("archived");
  onValueChange("updated");
  assert.deepEqual(selected, VIEW_VALUES);
});

test("视图菜单的受控值分别为三种视图", () => {
  for (const value of VIEW_VALUES) {
    const { markup, control } = renderViewContent(value);

    assert.equal(control.value, value);
    assert.match(markup, new RegExp(`data-slot="menu-radio-group" data-value="${value}"`));
  }
});

test("排序菜单按更新时间 / 创建时间顺序渲染，回传选择值并忽略非法值", () => {
  const { markup, selected, control } = renderSortContent("updated");

  assertOrdered(markup, SORT_VALUES);
  assert.match(markup, /workspaceSidebar\.sortBy/);
  assert.match(markup, /workspaceSidebar\.sortByUpdated/);
  assert.match(markup, /workspaceSidebar\.sortByCreated/);
  assert.doesNotMatch(markup, /workspaceSidebar\.organize/);

  const onValueChange = control.onValueChange;
  assert.ok(onValueChange);
  onValueChange("updated");
  onValueChange("created");
  assert.deepEqual(selected, SORT_VALUES);

  onValueChange("grouped");
  onValueChange("archived");
  assert.deepEqual(selected, SORT_VALUES);
});

test("排序菜单的受控值分别为两种排序", () => {
  for (const value of SORT_VALUES) {
    const { markup, control } = renderSortContent(value);

    assert.equal(control.value, value);
    assert.match(markup, new RegExp(`data-slot="menu-radio-group" data-value="${value}"`));
  }
});

function renderViewMenu(value: ViewValue, locale: "zh-CN" | "en-US" = "zh-CN"): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        ZCodeIntlProvider,
        { initialLocale: locale },
        createElement(WorkspaceSidebarTaskViewMenu, {
          value,
          onValueChange: () => undefined,
        }),
      ),
    ),
  );
}

test("视图触发器显示当前视图文案、图标与 chevron，并以「视图」为可访问名称", () => {
  const grouped = renderViewMenu("grouped");
  assert.match(grouped, /aria-label="视图"/);
  assert.match(grouped, /aria-haspopup="menu"/);
  assert.match(grouped, />分组</);
  assert.match(grouped, /lucide-hash/);
  assert.match(grouped, /lucide-chevron-down/);

  const project = renderViewMenu("project");
  assert.match(project, />项目</);
  assert.match(project, /lucide-folder/);

  const timeline = renderViewMenu("chronological");
  assert.match(timeline, />时间线</);
  assert.match(timeline, /lucide-clock-3/);
});

test("视图触发器文案跟随当前语言", () => {
  const markup = renderViewMenu("chronological", "en-US");

  assert.match(markup, /aria-label="View"/);
  assert.match(markup, />Timeline</);
});

test("排序触发器以「排序方式」为可访问名称并使用排序图标", () => {
  const markup = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(WorkspaceSidebarTaskSortMenu, {
          value: "updated",
          onValueChange: () => undefined,
        }),
      ),
    ),
  );

  assert.match(markup, /aria-label="排序方式"/);
  assert.match(markup, /aria-haspopup="menu"/);
  assert.match(markup, /lucide-arrow-up-down/);
});
