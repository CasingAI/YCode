import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  findMountedTimelineRowElement,
  isHiddenTimelineTurnNode,
} from "../src/v4/timelineStagedTurnDom.js";

/**
 * 本包没有 DOM 渲染环境（无 vitest / jsdom），暗处判定只依赖两件事：
 * 元素的 `closest` 命中哪些标记、根节点按选择器返回哪些候选。两者都用假件顶替，
 * 判定规则本身（跳过暗处副本、优先可见副本）由此覆盖。
 */
function createFakeElement(ancestorMarkers: readonly string[] = []): HTMLElement {
  const markers = new Set(ancestorMarkers);
  return {
    closest(selector: string): Element | null {
      for (const marker of markers) {
        if (selector.includes(marker)) {
          return { nodeName: "DIV" } as unknown as Element;
        }
      }
      return null;
    },
  } as unknown as HTMLElement;
}

function createFakeRoot(candidates: readonly HTMLElement[]): HTMLElement {
  return {
    querySelectorAll: () => candidates,
  } as unknown as HTMLElement;
}

const STAGED_MARKER = "data-staged-turn";
const FIRST_PAINT_MARKER = "data-v4-timeline-first-paint-staging";

test("暗处判定：前插块 staged 与首绘 staging 区都算暗处", () => {
  assert.equal(isHiddenTimelineTurnNode(createFakeElement([STAGED_MARKER])), true);
  assert.equal(isHiddenTimelineTurnNode(createFakeElement([FIRST_PAINT_MARKER])), true);
  assert.equal(isHiddenTimelineTurnNode(createFakeElement()), false);
});

test("落点查找：同一 rowId 有暗处副本与可见副本时取可见的那份", () => {
  const hidden = createFakeElement([STAGED_MARKER]);
  const visible = createFakeElement();
  const root = createFakeRoot([hidden, visible]);
  assert.equal(findMountedTimelineRowElement(root, 7), visible);
});

test("落点查找：只有暗处副本时不算落点", () => {
  const root = createFakeRoot([createFakeElement([STAGED_MARKER])]);
  assert.equal(findMountedTimelineRowElement(root, 7), null);
});

test("落点查找：没有该行时返回 null", () => {
  assert.equal(findMountedTimelineRowElement(createFakeRoot([]), 7), null);
});

const findHighlightSource = readFileSync(
  new URL("../src/v4/conversationFindHighlightDom.ts", import.meta.url),
  "utf8",
);
const timelineSource = readFileSync(
  new URL("../src/v4/ConversationTimeline.tsx", import.meta.url),
  "utf8",
);

test("接线：查找高亮与目录跳转都必须走「跳过暗处副本」的查找", () => {
  // 直接 querySelector 会先命中暗处副本（前插块的 staged 容器在虚拟列表之前），
  // 高亮落在看不见的节点上、跳转拿屏幕外坐标算落点。
  assert.match(
    findHighlightSource,
    /return findMountedTimelineRowElement\(root, rowId\);/,
    "查找高亮必须跳过暗处副本",
  );
  assert.match(
    timelineSource,
    /const rowElement = findMountedTimelineRowElement\(element, target\.rowId\);/,
    "目录跳转必须跳过暗处副本",
  );
  assert.doesNotMatch(
    timelineSource,
    /querySelector<HTMLElement>\(`\[data-row-id="\$\{target\.rowId\}"\]`\)/,
    "目录跳转不得再直接 querySelector：会先命中暗处副本",
  );
});
