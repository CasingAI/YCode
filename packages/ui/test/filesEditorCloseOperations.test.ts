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

test("close others plans one batch for many clean tabs", () => {
  const store = createFilesEditorStore();
  const buffers = Array.from({ length: 80 }, (_, index) => makeBuffer(`file-${index}`));
  for (const buffer of buffers) store.getState().openBuffer(buffer);
  const state = store.getState();
  const group = state.layout.groups[state.layout.focusedGroupId]!;
  const keep = buffers[0]!;
  const keepView = group.views.find((view) => view.bufferId === keep.id)!;
  const plan = planFilesEditorCloseOthers(state, state.layout, keep.id, keepView.id, group.id);

  assert.deepEqual(plan.viewIdsToRemove, []);
  assert.equal(plan.bufferIdsToClose.length, 79);
  assert.equal(plan.dirtyBufferId, undefined);
});

test("close others removes a split reference without closing its shared buffer", () => {
  const store = createFilesEditorStore();
  const keep = makeBuffer("keep");
  const shared = makeBuffer("shared");
  const close = makeBuffer("close");
  store.getState().openBuffer(keep);
  store.getState().openBuffer(shared);
  store.getState().openBuffer(close);
  const sourceGroupId = store.getState().layout.focusedGroupId;
  const source = store.getState().layout.groups[sourceGroupId]!;
  const sharedView = source.views.find((view) => view.bufferId === shared.id)!;
  store.getState().splitViewToEdge(sharedView.id, sourceGroupId, "right", "copy");

  const state = store.getState();
  const group = state.layout.groups[sourceGroupId]!;
  const keepView = group.views.find((view) => view.bufferId === keep.id)!;
  const plan = planFilesEditorCloseOthers(state, state.layout, keep.id, keepView.id, sourceGroupId);

  assert.deepEqual(plan.viewIdsToRemove, [sharedView.id]);
  assert.deepEqual(plan.bufferIdsToClose, [close.id]);
  assert.equal(plan.dirtyBufferId, undefined);
});

test("close others stops at the first dirty last view and leaves it for confirmation", () => {
  const store = createFilesEditorStore();
  const keep = makeBuffer("keep");
  const dirty = makeBuffer("dirty");
  const later = makeBuffer("later");
  store.getState().openBuffer(keep);
  store.getState().openBuffer(dirty);
  store.getState().openBuffer(later);
  store.getState().updateText(dirty.id, "unsaved");
  const state = store.getState();
  const group = state.layout.groups[state.layout.focusedGroupId]!;
  const keepView = group.views.find((view) => view.bufferId === keep.id)!;
  const plan = planFilesEditorCloseOthers(state, state.layout, keep.id, keepView.id, group.id);

  assert.deepEqual(plan.bufferIdsToClose, []);
  assert.equal(plan.dirtyBufferId, dirty.id);
});
