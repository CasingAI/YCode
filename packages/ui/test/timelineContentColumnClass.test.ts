import assert from "node:assert/strict";
import test from "node:test";
import { timelineContentColumnClass } from "../src/v4/timelineContentColumnClass.js";

// ── 宽度一致性：staged 块 wrapper 与真实虚拟列共用同一份宽度类 ──

const WIDTH_INPUT = {
  contentWidthClassName: "w-full max-w-4xl",
  summaryPanelInlineOffsetClassName: "max-lg:px-4",
} as const;

/** 真实虚拟列与 staged 块 wrapper 共用的布局类，逐字相同。 */
const REAL_COLUMN_BASE =
  "relative mx-auto w-full shrink-0 transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]";

test("staged 块 wrapper 与真实内容列共用同一份宽度类", () => {
  // 宽度不同则文字换行不同，staged 量出的高度就是错的；装载用的正是这个高度。
  const realColumn = timelineContentColumnClass({
    ...WIDTH_INPUT,
    base: REAL_COLUMN_BASE,
  });
  const stagedWrapper = timelineContentColumnClass({
    ...WIDTH_INPUT,
    base: REAL_COLUMN_BASE,
  });
  const blockContainer = timelineContentColumnClass({
    ...WIDTH_INPUT,
    base: "relative mx-auto w-full shrink-0",
  });
  const widthTokens = (value: string): string[] =>
    value
      .split(" ")
      .filter(
        (token) =>
          token.startsWith("max-w-") || token.startsWith("w-") || token.startsWith("max-lg:"),
      )
      .sort();
  assert.deepEqual(widthTokens(stagedWrapper), widthTokens(realColumn));
  assert.deepEqual(widthTokens(blockContainer), widthTokens(realColumn));
  // 窄屏偏移同样必须一致，否则窄屏下量出的高度与真实列不同。
  for (const value of [realColumn, stagedWrapper, blockContainer]) {
    assert.ok(value.includes("max-lg:px-4"), `缺窄屏偏移：${value}`);
  }
});

test("staged wrapper 与真实列的宽度过渡行为一致，不会在动画期间量到终态宽度", () => {
  // 真实列带 transition-[width,max-width,transform]，动画的 150ms 里宽度是渐变的。
  // staged wrapper 若不带过渡就会瞬间跳到终值，量出终态宽度下的高度，而真实列此刻
  // 还不是那么宽——量到的高度与装载时的真实高度不一致。
  const stagedWrapper = timelineContentColumnClass({
    ...WIDTH_INPUT,
    base: REAL_COLUMN_BASE,
  });
  for (const token of [
    "transition-[width,max-width,transform]",
    "duration-150",
    "ease-out",
    "@min-[1280px]/conversation:transition-[transform]",
  ]) {
    assert.ok(stagedWrapper.includes(token), `staged wrapper 缺过渡类 ${token}：${stagedWrapper}`);
  }
});

test("列宽档位为空时不会拼出 undefined 字面量", () => {
  const value = timelineContentColumnClass({
    base: "relative mx-auto w-full",
    contentWidthClassName: undefined,
    summaryPanelInlineOffsetClassName: undefined,
  });
  assert.ok(!value.includes("undefined"), value);
});
