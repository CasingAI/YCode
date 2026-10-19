import assert from "node:assert/strict";
import test from "node:test";
import {
  FILES_EDITOR_SPLIT_EDGE_RATIO,
  filesEditorSplitEdgeAtPoint,
} from "../src/files-workbench/filesEditorDropZone.js";

const widePane = { left: 100, top: 50, width: 1200, height: 400 };

test("split drop zones use the reference 22% ratio independently on each axis", () => {
  assert.equal(FILES_EDITOR_SPLIT_EDGE_RATIO, 0.22);
  assert.equal(filesEditorSplitEdgeAtPoint(200, 250, widePane), "left");
  assert.equal(filesEditorSplitEdgeAtPoint(1100, 250, widePane), "right");
  assert.equal(filesEditorSplitEdgeAtPoint(700, 100, widePane), "top");
  assert.equal(filesEditorSplitEdgeAtPoint(700, 390, widePane), "bottom");
  assert.equal(filesEditorSplitEdgeAtPoint(500, 250, widePane), undefined);
});

test("corners choose a horizontal split first and invalid bounds never trigger a split", () => {
  assert.equal(filesEditorSplitEdgeAtPoint(110, 60, widePane), "left");
  assert.equal(filesEditorSplitEdgeAtPoint(99, 250, widePane), undefined);
  assert.equal(filesEditorSplitEdgeAtPoint(500, 500, widePane), undefined);
  assert.equal(filesEditorSplitEdgeAtPoint(100, 100, { left: 0, top: 0, width: 0, height: 400 }), undefined);
});
