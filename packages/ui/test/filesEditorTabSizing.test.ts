import assert from "node:assert/strict";
import test from "node:test";
import {
  FILES_EDITOR_TAB_CROWD_THRESHOLD,
  filesEditorTabFlex,
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
