import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveThoughtTooltipTitle } from "../src/chat-input-toolbar/thoughtLevelOptions.js";

/**
 * echo 版断言素材：文案值写字面量，不 import i18n 常量，
 * 避免断言的是同一个值（同 modelChangeThoughtLabel.test.ts 的约定）。
 */
const tooltipTitle = "chat.toolbar.thoughtLevel.tooltip";
const currentLabel = "chat.toolbar.thoughtLevel.value.high";

test("toolbar 形态：内联文字可见时提示显示控件用途文案", () => {
  assert.equal(
    resolveThoughtTooltipTitle({
      variant: "toolbar",
      inlineLabelVisible: true,
      tooltipTitle,
      currentLabel,
    }),
    tooltipTitle,
  );
});

test("toolbar 形态：内联文字被窄容器隐藏时提示直接给档位词", () => {
  assert.equal(
    resolveThoughtTooltipTitle({
      variant: "toolbar",
      inlineLabelVisible: false,
      tooltipTitle,
      currentLabel,
    }),
    currentLabel,
  );
});

test("levelBar 形态：没有内联文字，提示恒为档位词", () => {
  for (const inlineLabelVisible of [true, false]) {
    assert.equal(
      resolveThoughtTooltipTitle({
        variant: "levelBar",
        inlineLabelVisible,
        tooltipTitle,
        currentLabel,
      }),
      currentLabel,
    );
  }
});

test("disabledReason 永远优先，两种形态一致", () => {
  for (const variant of ["toolbar", "levelBar"] as const) {
    assert.equal(
      resolveThoughtTooltipTitle({
        variant,
        disabledReason: "当前任务运行中，不能切换",
        inlineLabelVisible: true,
        tooltipTitle,
        currentLabel,
      }),
      "当前任务运行中，不能切换",
    );
  }
});
