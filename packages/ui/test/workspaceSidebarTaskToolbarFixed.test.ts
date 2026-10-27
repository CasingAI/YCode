// 静态结构回归，不是 GUI / E2E：只解析 WorkspaceSidebar.tsx 的 JSX 层级，
// 锁定「工具栏整行在滚动视口外、吸顶槽与视口同层、渐隐只作用于视口」。

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = ts.createSourceFile(
  "WorkspaceSidebar.tsx",
  await readFile(new URL("../src/WorkspaceSidebar.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

type JsxTag = ts.JsxElement | ts.JsxSelfClosingElement;

const parents = new Map<ts.Node, ts.Node>();
function indexParents(node: ts.Node) {
  ts.forEachChild(node, (child) => {
    parents.set(child, node);
    indexParents(child);
  });
}
indexParents(source);

function ancestors(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  let current = parents.get(node);
  while (current) {
    result.push(current);
    current = parents.get(current);
  }
  return result;
}

function isJsxTag(node: ts.Node): node is JsxTag {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

function tagName(node: JsxTag): string {
  return ts.isJsxElement(node)
    ? node.openingElement.tagName.getText(source)
    : node.tagName.getText(source);
}

function attributesOf(node: JsxTag): ts.JsxAttributes {
  return ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
}

function attribute(node: JsxTag, name: string): ts.JsxAttribute | undefined {
  return attributesOf(node).properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText(source) === name,
  );
}

function expressionTextAttribute(node: JsxTag, name: string): string | null {
  const initializer = attribute(node, name)?.initializer;
  if (!initializer || !ts.isJsxExpression(initializer)) {
    return null;
  }
  return initializer.expression?.getText(source) ?? null;
}

function classNames(node: JsxTag): string[] {
  const initializer = attribute(node, "className")?.initializer;
  let value: ts.Expression | undefined;
  if (initializer) {
    value = ts.isJsxExpression(initializer) ? initializer.expression : initializer;
  }
  const text = value && ts.isStringLiteral(value) ? value.text : (value?.getText(source) ?? "");
  return text.split(/\s+/).filter(Boolean);
}

function nearestJsxElement(node: ts.Node): ts.JsxElement | undefined {
  return ancestors(node).find(ts.isJsxElement);
}

/** 直接子节点里的 JSX 元素，用于判断相邻顺序而不受空白文本影响。 */
function directElementChildren(node: ts.JsxElement): JsxTag[] {
  return node.children.filter(isJsxTag);
}

const jsxTags: JsxTag[] = [];
const jsxElements: ts.JsxElement[] = [];
const callExpressions: ts.CallExpression[] = [];
function collect(node: ts.Node) {
  if (ts.isJsxElement(node)) {
    jsxElements.push(node);
  }
  if (isJsxTag(node)) {
    jsxTags.push(node);
  }
  if (ts.isCallExpression(node)) {
    callExpressions.push(node);
  }
  ts.forEachChild(node, collect);
}
collect(source);

const scrollViewport = jsxElements.find(
  (node) => expressionTextAttribute(node, "ref") === "workspaceScrollRef",
);
assert.ok(scrollViewport, "找不到 workspaceScrollRef 滚动视口");
assert.equal(
  jsxElements.filter((node) => expressionTextAttribute(node, "ref") === "workspaceScrollRef")
    .length,
  1,
  "workspaceScrollRef 滚动视口应唯一",
);

const stickySlot = jsxTags.find((node) => tagName(node) === "StickyGroupHeaderSlot");
assert.ok(stickySlot, "找不到 StickyGroupHeaderSlot");

const toolbarCalls = callExpressions.filter(
  (node) => node.expression.getText(source) === "workspaceTaskToolbar",
);
assert.equal(toolbarCalls.length, 1, "workspaceTaskToolbar 只能调用一次");
const toolbarCall = toolbarCalls[0];

const relativeLayer = nearestJsxElement(scrollViewport);
assert.ok(relativeLayer, "找不到滚动视口的定位包裹层");
const relativeClassNames = classNames(relativeLayer);
for (const required of ["relative", "flex-1", "min-h-0", "flex-col"]) {
  assert.ok(relativeClassNames.includes(required), `定位包裹层缺少 ${required}`);
}

test("工具栏整行是滚动视口之外的前置兄弟", () => {
  assert.ok(!ancestors(toolbarCall).includes(scrollViewport), "工具栏不能位于滚动视口内");

  const toolbarWrapper = nearestJsxElement(toolbarCall);
  assert.ok(toolbarWrapper, "找不到工具栏固定包裹层");
  const wrapperClassNames = classNames(toolbarWrapper);
  assert.ok(wrapperClassNames.includes("shrink-0"), "工具栏包裹层需要 shrink-0");
  assert.ok(wrapperClassNames.includes("pb-3"), "工具栏包裹层需要 pb-3");

  assert.ok(
    !ancestors(toolbarCall).includes(relativeLayer),
    "工具栏不能位于吸顶槽所在的定位包裹层内",
  );

  const container = nearestJsxElement(relativeLayer);
  assert.ok(container, "找不到滚动区域外层容器");
  assert.equal(nearestJsxElement(toolbarWrapper), container, "工具栏包裹层与定位包裹层应为兄弟");

  const siblings = directElementChildren(container);
  const wrapperIndex = siblings.indexOf(toolbarWrapper);
  const relativeIndex = siblings.indexOf(relativeLayer);
  assert.ok(wrapperIndex >= 0, "工具栏包裹层不是外层容器的直接子元素");
  assert.equal(relativeIndex, wrapperIndex + 1, "工具栏包裹层应紧邻定位包裹层之前");
});

test("吸顶槽与滚动视口同层且在视口之前，不包含工具栏", () => {
  assert.ok(!ancestors(stickySlot).includes(scrollViewport), "吸顶槽不能位于滚动视口内");
  assert.equal(nearestJsxElement(stickySlot), relativeLayer, "吸顶槽应直接位于定位包裹层中");
  assert.ok(
    stickySlot.getStart(source) < scrollViewport.getStart(source),
    "吸顶槽应位于滚动视口之前",
  );
});

test("置顶区有始终挂载的稳定包装层，空时不占间距", () => {
  const pinned = jsxTags.find((node) => tagName(node) === "WorkspacePinnedTasksSection");
  assert.ok(pinned, "找不到 WorkspacePinnedTasksSection");

  const pinnedWrapper = nearestJsxElement(pinned);
  assert.ok(pinnedWrapper, "找不到置顶区包装层");
  assert.notEqual(pinnedWrapper, scrollViewport, "置顶组件不能直接落在滚动视口");
  assert.ok(classNames(pinnedWrapper).includes("empty:hidden"), "置顶区包装层需要 empty:hidden");
  assert.equal(
    nearestJsxElement(pinnedWrapper),
    scrollViewport,
    "置顶区包装层应是滚动视口的直接子元素",
  );
});

test("滚动视口承载主列表，滚动渐隐只作用于视口", () => {
  const viewportClassNames = classNames(scrollViewport);
  assert.ok(viewportClassNames.includes("overflow-y-auto"), "滚动视口需要 overflow-y-auto");
  assert.ok(viewportClassNames.includes("flex-col"), "滚动视口需要纵向排列");

  const maskAttributes = jsxTags.flatMap((tag) =>
    attributesOf(tag).properties.filter(
      (property): property is ts.JsxAttribute =>
        ts.isJsxAttribute(property) &&
        property.name.getText(source) === "style" &&
        property.initializer !== undefined &&
        ts.isJsxExpression(property.initializer) &&
        property.initializer.expression?.getText(source) === "workspaceScrollMaskStyle",
    ),
  );
  assert.equal(maskAttributes.length, 1, "workspaceScrollMaskStyle 只能用于滚动视口一次");
  const maskOwner = maskAttributes[0].parent.parent;
  assert.ok(
    ts.isJsxOpeningElement(maskOwner) && maskOwner.parent === scrollViewport,
    "workspaceScrollMaskStyle 必须绑定在滚动视口上",
  );

  const stableList = jsxElements.find(
    (node) => classNames(node).join(" ") === "flex min-h-0 flex-col gap-3 px-2",
  );
  assert.ok(stableList, "找不到稳定主列表容器");
  assert.equal(nearestJsxElement(stableList), scrollViewport, "稳定主列表应是滚动视口的直接子元素");
});
