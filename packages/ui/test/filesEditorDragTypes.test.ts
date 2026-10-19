import assert from "node:assert/strict";
import test from "node:test";
import {
  FILES_EDITOR_VIEW_DRAG_MIME,
  isExternalFilesDrag,
  isFilesEditorViewDrag,
} from "../src/files-workbench/filesEditorDragTypes.js";

function transfer(types: string[], fileCount = 0) {
  return {
    types,
    files: { length: fileCount },
  } as unknown as DataTransfer;
}

test("internal editor-tab drags are not classified as external file drops", () => {
  const data = transfer(["text/plain", FILES_EDITOR_VIEW_DRAG_MIME, "Files"], 1);
  assert.equal(isFilesEditorViewDrag(data), true);
  assert.equal(isExternalFilesDrag(data), false);
});

test("native file drops are still recognized", () => {
  assert.equal(isFilesEditorViewDrag(transfer(["Files"], 1)), false);
  assert.equal(isExternalFilesDrag(transfer(["Files"], 1)), true);
  assert.equal(isExternalFilesDrag(transfer(["application/octet-stream"], 1)), true);
});

test("missing transfer payloads are safely ignored", () => {
  assert.equal(isFilesEditorViewDrag(undefined), false);
  assert.equal(isExternalFilesDrag(undefined), false);
});
