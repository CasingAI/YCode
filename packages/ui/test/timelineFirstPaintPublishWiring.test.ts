import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const timelineSource = readFileSync(
  new URL("../src/v4/ConversationTimeline.tsx", import.meta.url),
  "utf8",
);
const statusPanelSource = readFileSync(
  new URL("../src/v4/ConversationStatusPanel.tsx", import.meta.url),
  "utf8",
);
const sessionPaneSource = readFileSync(
  new URL("../src/v4/SessionPane.tsx", import.meta.url),
  "utf8",
);

function effectBody(anchor: string, source: string, endAnchor = "});"): string {
  const start = source.indexOf(anchor);
  assert.notEqual(start, -1, `找不到锚点：${anchor}`);
  const end = source.indexOf(endAnchor, start);
  assert.notEqual(end, -1, `${anchor} 所在 effect 没有闭合`);
  return source.slice(start, end);
}

function assertShortCircuitsBeforeSetter(
  body: string,
  refName: string,
  setterName: string,
  label: string,
): void {
  const refIndex = body.indexOf(refName);
  const setterIndex = body.indexOf(`${setterName}(`);
  assert.notEqual(refIndex, -1, `${label} 必须在调用 setter 前用 ${refName} 比对`);
  assert.notEqual(setterIndex, -1, `${label} 找不到 setter：${setterName}`);
  assert.ok(refIndex < setterIndex, `${label} 的 ref 比对必须排在 setter 之前`);
  assert.equal(
    body.includes(`${setterName}((`),
    false,
    `${label} 不得继续使用 updater 形式：updater 内返回旧值仍会累计嵌套更新`,
  );
}

/**
 * React #185 回归：首绘 staging 的测量 effect 没有依赖数组，staging 期间每次
 * commit 都会重跑。setter updater 里判等返回旧值仍会排入嵌套更新，超过 50 次
 * 就抛 Maximum update depth exceeded，整块聊天区被错误边界接管。
 *
 * 这类缺陷纯逻辑层测不到，按仓库既有的源码接线断言钉住「先比较、后发布」。
 */
test("首绘测量 effect 发布视口高度前必须先比对 ref", () => {
  const body = effectBody(
    "const viewportHeightPx = scrollRef.current?.clientHeight ?? 0;",
    timelineSource,
  );
  assertShortCircuitsBeforeSetter(
    body,
    "firstPaintViewportHeightPxRef.current !== viewportHeightPx",
    "setFirstPaintViewportHeightPx",
    "首绘视口高度",
  );
});

test("首绘测量 effect 发布折叠总高前必须先比对 ref", () => {
  const body = effectBody(
    "const currentStagedHeight = firstPaintStagedHeightRef.current;",
    timelineSource,
  );
  assertShortCircuitsBeforeSetter(
    body,
    "firstPaintStagedHeightRef.current",
    "setFirstPaintStagedHeight",
    "首绘折叠总高",
  );
});

test("ResizeObserver 发布同一视口高度时复用同一把 ref", () => {
  const body = effectBody(
    "const sync = () => {\n      const next = element.clientHeight;",
    timelineSource,
    "}, []);",
  );
  assertShortCircuitsBeforeSetter(
    body,
    "firstPaintViewportHeightPxRef.current === next",
    "setFirstPaintViewportHeightPx",
    "视口高度 observer",
  );
});

test("状态面板的迷你宽度只在真实变化时发布", () => {
  const body = effectBody("const updateMiniWidth = () => {", statusPanelSource, "}, [model]);");
  assertShortCircuitsBeforeSetter(body, "miniWidthRef.current", "setMiniWidth", "状态面板迷你宽度");
});

test("SessionPane 不得用内联空数组击穿状态面板的 memo", () => {
  assert.doesNotMatch(sessionPaneSource, /backgroundWorks=\{[^}]*\?\?\s*\[\]\s*\}/);
  assert.doesNotMatch(sessionPaneSource, /workflowRuns=\{[^}]*\?\?\s*\[\]\s*\}/);
});
