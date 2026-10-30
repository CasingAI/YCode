import assert from "node:assert/strict";
import test from "node:test";
import {
  FILES_EDITOR_TAB_CROWD_THRESHOLD,
  filesEditorTabFlex,
  resolveFilesEditorTabScrollLeft,
  shouldCrowdFilesEditorTabs,
} from "../src/files-workbench/filesEditorTabSizing.js";

test("Tab 平均宽度低于 96px 才进入拥挤模式", () => {
  assert.equal(FILES_EDITOR_TAB_CROWD_THRESHOLD, 96);
  assert.equal(shouldCrowdFilesEditorTabs(192, 2), false);
  assert.equal(shouldCrowdFilesEditorTabs(191, 2), true);
  assert.equal(shouldCrowdFilesEditorTabs(95, 1), false);
  assert.equal(shouldCrowdFilesEditorTabs(0, 0), false);
  assert.equal(shouldCrowdFilesEditorTabs(Number.NaN, 2), false);
});

test("拥挤模式只扩展活动或悬停标签", () => {
  assert.equal(filesEditorTabFlex(false, true, false), "1 1 0%");
  assert.equal(filesEditorTabFlex(true, true, false), "2.4 1 0%");
  assert.equal(filesEditorTabFlex(true, false, true), "2.4 1 0%");
  assert.equal(filesEditorTabFlex(true, false, false), "1 1 0%");
});

test("程序激活右侧标签时把活动标签滚入可视区", () => {
  // 320px 组内 4 个 96px 标签、标签区可视宽度 228px：第 4 个标签完全在视口外。
  assert.equal(
    resolveFilesEditorTabScrollLeft({
      scrollLeft: 0,
      viewportWidth: 228,
      scrollWidth: 384,
      tabOffsetLeft: 288,
      tabWidth: 96,
    }),
    156,
  );
  // 窄分屏第 3 个标签：只滚到刚好露出整个标签。
  assert.equal(
    resolveFilesEditorTabScrollLeft({
      scrollLeft: 0,
      viewportWidth: 104,
      scrollWidth: 288,
      tabOffsetLeft: 192,
      tabWidth: 96,
    }),
    184,
  );
});

test("活动标签在左侧被裁掉时向左校正，已完整可见时不动", () => {
  assert.equal(
    resolveFilesEditorTabScrollLeft({
      scrollLeft: 156,
      viewportWidth: 228,
      scrollWidth: 384,
      tabOffsetLeft: -156,
      tabWidth: 96,
    }),
    0,
  );
  assert.equal(
    resolveFilesEditorTabScrollLeft({
      scrollLeft: 96,
      viewportWidth: 228,
      scrollWidth: 384,
      tabOffsetLeft: 0,
      tabWidth: 96,
    }),
    96,
  );
});

test("滚动校正受内容上限约束，标签比可视区更宽时对齐标签起点", () => {
  assert.equal(
    resolveFilesEditorTabScrollLeft({
      scrollLeft: 0,
      viewportWidth: 228,
      scrollWidth: 688,
      tabOffsetLeft: 288,
      tabWidth: 400,
    }),
    288,
  );
  assert.equal(
    resolveFilesEditorTabScrollLeft({
      scrollLeft: 0,
      viewportWidth: 80,
      scrollWidth: 200,
      tabOffsetLeft: 100,
      tabWidth: 96,
    }),
    100,
  );
  assert.equal(
    resolveFilesEditorTabScrollLeft({
      scrollLeft: 0,
      viewportWidth: 0,
      scrollWidth: 384,
      tabOffsetLeft: 288,
      tabWidth: 96,
    }),
    0,
  );
});
