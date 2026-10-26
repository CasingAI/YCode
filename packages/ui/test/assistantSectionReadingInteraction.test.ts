import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSISTANT_SECTION_DRAG_THRESHOLD_PX,
  hasExceededAssistantSectionDragThreshold,
  resolveAssistantSectionKeyboardIntent,
  resolveAssistantSectionMinHeight,
  shouldAdvanceAssistantSectionFromClick,
} from "../src/v4/AssistantSectionReadingInteraction.js";

test("click on the card advances only when the target is the card, selection is collapsed and no drag happened", () => {
  const base = {
    targetIsCard: true,
    clickCount: 1,
    selectionCollapsed: true,
    selectionCollapsedAtPointerDown: true,
    dragExceeded: false,
  };
  assert.equal(shouldAdvanceAssistantSectionFromClick(base), true);
  assert.equal(shouldAdvanceAssistantSectionFromClick({ ...base, targetIsCard: false }), false);
  assert.equal(shouldAdvanceAssistantSectionFromClick({ ...base, clickCount: 2 }), false);
  assert.equal(
    shouldAdvanceAssistantSectionFromClick({ ...base, selectionCollapsed: false }),
    false,
  );
  // 点击空白会先折叠旧选区；起点存在选区时不能把 collapse 后的 click 当成空白翻页。
  assert.equal(
    shouldAdvanceAssistantSectionFromClick({ ...base, selectionCollapsedAtPointerDown: false }),
    false,
  );
  assert.equal(shouldAdvanceAssistantSectionFromClick({ ...base, dragExceeded: true }), false);
});

test("drag threshold ignores jitter and suppresses real selection swipes", () => {
  const start = { x: 100, y: 100 };
  assert.equal(hasExceededAssistantSectionDragThreshold(null, { x: 200, y: 200 }), false);
  assert.equal(
    hasExceededAssistantSectionDragThreshold(start, {
      x: 100 + ASSISTANT_SECTION_DRAG_THRESHOLD_PX,
      y: 100,
    }),
    false,
  );
  assert.equal(
    hasExceededAssistantSectionDragThreshold(start, {
      x: 100 + ASSISTANT_SECTION_DRAG_THRESHOLD_PX + 1,
      y: 100,
    }),
    true,
  );
  assert.equal(hasExceededAssistantSectionDragThreshold(start, { x: 90, y: 140 }), true);
});

test("local keyboard navigation accepts arrows and page keys but never body controls", () => {
  const base = { targetInsideContent: false };
  assert.equal(resolveAssistantSectionKeyboardIntent({ ...base, key: "ArrowRight" }), 1);
  assert.equal(resolveAssistantSectionKeyboardIntent({ ...base, key: "PageDown" }), 1);
  assert.equal(resolveAssistantSectionKeyboardIntent({ ...base, key: "ArrowLeft" }), -1);
  assert.equal(resolveAssistantSectionKeyboardIntent({ ...base, key: "PageUp" }), -1);
  assert.equal(resolveAssistantSectionKeyboardIntent({ ...base, key: "Enter" }), null);
  assert.equal(
    resolveAssistantSectionKeyboardIntent({ key: "ArrowRight", targetInsideContent: true }),
    null,
  );
  assert.equal(
    resolveAssistantSectionKeyboardIntent({
      ...base,
      key: "ArrowRight",
      defaultPrevented: true,
    }),
    null,
  );
  assert.equal(
    resolveAssistantSectionKeyboardIntent({ ...base, key: "ArrowRight", hasModifier: true }),
    null,
  );
});

test("card minimum height follows the measured reading container and stays bounded", () => {
  const desktop = (availableHeight: number | null, viewportHeight = 900) =>
    resolveAssistantSectionMinHeight({ availableHeight, viewportHeight, viewportWidth: 1280 });
  const mobile = (availableHeight: number | null, viewportHeight = 700) =>
    resolveAssistantSectionMinHeight({ availableHeight, viewportHeight, viewportWidth: 390 });

  assert.equal(desktop(800), 368);
  assert.equal(desktop(0), 414);
  assert.equal(
    resolveAssistantSectionMinHeight({
      availableHeight: 718,
      availableWidth: 1399,
      viewportHeight: 900,
      viewportWidth: 1440,
    }),
    330,
  );
  assert.equal(desktop(200), 220);
  assert.equal(desktop(2000), 480);
  assert.equal(mobile(800), 320);
  assert.equal(mobile(300), 160);
  assert.equal(desktop(null), 414);
  assert.ok(desktop(600) > desktop(400));
  // 分栏窗口里对话容器比视口窄时使用窄屏比例与上限。
  assert.equal(
    resolveAssistantSectionMinHeight({
      availableHeight: 800,
      viewportHeight: 900,
      viewportWidth: 1280,
      availableWidth: 480,
    }),
    320,
  );
});
