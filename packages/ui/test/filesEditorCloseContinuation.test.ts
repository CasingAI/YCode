import assert from "node:assert/strict";
import test from "node:test";
import { planFilesEditorCloseOthers } from "../src/files-workbench/filesEditorCloseOperations.js";
import { filesFileBufferId } from "../src/files-workbench/filesEditorModel.js";
import { createFilesEditorStore } from "../src/files-workbench/filesEditorStore.js";
import type { FilesWorkspaceRef } from "../src/files-workbench/filesEditorTypes.js";

const workspace: FilesWorkspaceRef = { workspacePath: "/workspace" };

function makeBuffer(name: string) {
  return {
    id: filesFileBufferId(workspace, `/workspace/${name}.ts`),
    kind: "text" as const,
    untitled: false,
    path: `/workspace/${name}.ts`,
    title: `${name}.ts`,
    text: name,
    savedText: name,
    workspace,
  };
}

test("close others can resume after a dirty tab is saved and finish closing remaining clean tabs", () => {
  const store = createFilesEditorStore();
  const keep = makeBuffer("resume-keep");
  const dirty = makeBuffer("resume-dirty");
  const later = makeBuffer("resume-later");
  for (const buffer of [keep, dirty, later]) store.getState().openBuffer(buffer);
  store.getState().updateText(dirty.id, "unsaved changes");

  const first = store.getState();
  const groupId = first.layout.focusedGroupId;
  const keepViewId = first.layout.groups[groupId]!.views.find(
    (view) => view.bufferId === keep.id,
  )!.id;
  const initial = planFilesEditorCloseOthers(first, first.layout, keep.id, keepViewId, groupId);
  assert.equal(initial.dirtyBufferId, dirty.id);
  assert.deepEqual(initial.bufferIdsToClose, []);

  store.getState().markSaved(dirty.id, {
    path: dirty.path,
    text: "unsaved changes",
    workspace,
  });
  const resumed = store.getState();
  const plan = planFilesEditorCloseOthers(resumed, resumed.layout, keep.id, keepViewId, groupId);
  assert.equal(plan.dirtyBufferId, undefined);
  assert.deepEqual(plan.bufferIdsToClose, [dirty.id, later.id]);
  store.getState().closeViewsAndBuffers(plan);
  assert.deepEqual(store.getState().openIds, [keep.id]);
});
