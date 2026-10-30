import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsGroupCard } from "../src/settings/SettingsPageParts.js";
import {
  projectCandidatesToOrder,
  type WebSearchOrderCandidate,
} from "../src/settings/webSearchCandidateOrder.js";

// 纯投影、静态接线与服务端渲染契约；useOptimisticReorder 的 pending/串行/回退
// 由 webSearchSettingsReorderBrowser.test.ts 在独立浏览器中真实执行。

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

const sectionSource = read("../src/settings/WebSearchSettingsSection.tsx");
const partsSource = read("../src/settings/SettingsPageParts.tsx");

function candidate(providerId: string): WebSearchOrderCandidate & { label: string } {
  return { providerId, label: providerId };
}

const ids = (items: readonly { providerId: string }[]) => items.map((item) => item.providerId);

function handlerSource(name: string, nextMarker: string): string {
  const start = sectionSource.indexOf(`const ${name} = useCallback(`);
  const end = start < 0 ? -1 : sectionSource.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start, `应能定位 ${name} 源码片段`);
  return sectionSource.slice(start, end);
}

test("纯投影：按给定 provider 顺序输出候选，未知 id 跳过", () => {
  const authoritative = ["a", "b", "c"].map(candidate);
  assert.deepEqual(ids(projectCandidatesToOrder(authoritative, ["c", "a", "b"])), ["c", "a", "b"]);
  assert.deepEqual(ids(projectCandidatesToOrder(authoritative, ["b", "c", "a"])), ["b", "c", "a"]);
  assert.deepEqual(ids(projectCandidatesToOrder(authoritative, ["gone", "b", "a", "c"])), [
    "b",
    "a",
    "c",
  ]);
});

test("静态接线：设置页复用 useOptimisticReorder，拖拽与箭头共用同一提交入口", () => {
  assert.equal(
    sectionSource.match(/useOptimisticReorder\(/g)?.length,
    1,
    "网络搜索页只允许一个 UI pending owner",
  );
  assert.match(
    sectionSource,
    /const optimisticOrder = useOptimisticReorder\(\{[\s\S]*?authoritativeIds[\s\S]*?persist: persistOrder/,
  );
  assert.match(
    sectionSource,
    /const persistOrder = useCallback\([\s\S]*?await update\(\{ webSearchProviderOrder: \[\.\.\.ids\] \}\)/,
    "持久化仍只走既有 settings update",
  );
  const handleMoveSource = handlerSource("handleMove", "const handleDragEnd = useCallback(");
  assert.match(
    handleMoveSource,
    /commitRenderedOrder\(arrayMove\(candidateIds\(renderedCandidates\), fromIndex, toIndex\)\)/,
    "箭头的 arrayMove 操作数必须来自 renderedCandidates",
  );
  assert.doesNotMatch(handleMoveSource, /authoritativeIds|orderedCandidates/);
  const handleDragEndSource = handlerSource("handleDragEnd", "const sensors = useSensors(");
  assert.match(
    handleDragEndSource,
    /const ids = candidateIds\(renderedCandidates\)/,
    "拖拽落点必须基于 renderedCandidates 计算",
  );
  assert.match(
    handleDragEndSource,
    /commitRenderedOrder\(arrayMove\(ids, activeIndex, overIndex\)\)/,
  );
  assert.doesNotMatch(handleDragEndSource, /authoritativeIds|orderedCandidates/);
  assert.doesNotMatch(sectionSource, /void commitOrder\(/, "不得保留绕过 pending 的直接提交");
  assert.match(
    sectionSource,
    /optimisticOrder\.commit\([\s\S]*?\.catch\(\(error[^)]*\)[\s\S]*?logger\.warn/,
    "提交失败要记录错误",
  );
  assert.match(
    sectionSource,
    /projectCandidatesToOrder\(orderedCandidates, optimisticOrder\.renderedIds\)/,
    "渲染顺序来自 pending 投影",
  );
  assert.match(sectionSource, /renderedCandidates\.map\(\(candidate, index\)/);
});

test("服务端渲染：默认设置卡片裁切，仅候选排序卡片取消裁切", () => {
  assert.match(
    renderToStaticMarkup(createElement(SettingsGroupCard, null, createElement("div", null, "row"))),
    /overflow-hidden/,
  );
  const unclippedMarkup = renderToStaticMarkup(
    createElement(
      SettingsGroupCard,
      { className: "overflow-visible" },
      createElement("div", null, "row"),
    ),
  );
  assert.match(unclippedMarkup, /overflow-visible/);
  assert.doesNotMatch(unclippedMarkup, /overflow-hidden/);
  assert.match(partsSource, /export function SettingsGroupCard\(\{[\s\S]*?className\?: string;/);
  assert.equal(
    sectionSource.match(/<SettingsGroupCard className="overflow-visible">/g)?.length,
    1,
    "只允许候选排序卡片取消裁切",
  );
});

test("静态契约：排序入口保留键盘/触屏与禁用门控", () => {
  assert.match(
    sectionSource,
    /KeyboardSensor, \{ coordinateGetter: sortableKeyboardCoordinates \}/,
  );
  assert.match(sectionSource, /PointerSensor, \{ activationConstraint: \{ distance: 6 \} \}/);
  assert.match(sectionSource, /disabled=\{!webSearchEnabled\}/);
  assert.match(sectionSource, /disabled=\{sortDisabled\}/, "拖拽手柄由 sortDisabled 门控");
  assert.match(
    sectionSource,
    /disabled=\{sortDisabled \|\| index === 0\}/,
    "上移按钮由 sortDisabled 门控",
  );
  assert.match(
    sectionSource,
    /disabled=\{sortDisabled \|\| index === total - 1\}/,
    "下移按钮由 sortDisabled 门控",
  );
  assert.match(
    sectionSource,
    /data-testid=\{`settings\.webSearch\.openSettings\.\$\{candidate\.providerId\}`\}\s+onClick=\{onOpenSettings\}/,
    "实例设置入口不随总开关禁用",
  );
  assert.match(sectionSource, /touch-none/);
  assert.match(
    sectionSource,
    /isDragging \? "relative z-20 bg-card shadow-md" : ""/,
    "拖动行需要不透明背景与阴影，避免透出下层内容",
  );
});
