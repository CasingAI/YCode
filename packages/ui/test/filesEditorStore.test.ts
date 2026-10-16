import assert from "node:assert/strict";
import test from "node:test";
import { filesFileBufferId } from "../src/files-workbench/filesEditorModel.js";
import { createFilesEditorStore } from "../src/files-workbench/filesEditorStore.js";
import type {
  FilesPersistedSession,
  FilesWorkspaceRef,
} from "../src/files-workbench/filesEditorTypes.js";

const workspace: FilesWorkspaceRef = { workspacePath: "/workspace" };

test("hydrating a persisted session restores tab metadata without file contents", () => {
  const cleanId = filesFileBufferId(workspace, "/workspace/src/app.ts");
  const previewId = filesFileBufferId(workspace, "/workspace/assets/logo.png");
  const dirtyId = filesFileBufferId(workspace, "/workspace/README.md");
  const session: FilesPersistedSession = {
    version: 1,
    activeId: cleanId,
    openFileIds: [dirtyId, cleanId, previewId],
    openTabs: [
      { id: dirtyId, kind: "text", path: "/workspace/README.md", workspace },
      { id: cleanId, kind: "text", path: "/workspace/src/app.ts", workspace },
      {
        id: previewId,
        kind: "preview",
        path: "/workspace/assets/logo.png",
        workspace,
        preview: true,
      },
    ],
    drafts: [
      {
        id: dirtyId,
        path: "/workspace/README.md",
        title: "README.md",
        text: "unsaved",
        savedText: "saved",
        workspace,
        untitled: false,
      },
    ],
  };

  const store = createFilesEditorStore();
  store.getState().hydrateSession(session);
  const state = store.getState();

  assert.deepEqual(state.openIds, [dirtyId, cleanId, previewId]);
  assert.equal(state.activeId, cleanId);
  assert.deepEqual(
    state.buffers.map((buffer) => buffer.id),
    [dirtyId, cleanId, previewId],
  );
  assert.equal(state.buffers[0]?.kind === "text" ? state.buffers[0].text : undefined, "unsaved");
  assert.equal(
    state.buffers[1]?.kind === "text" ? state.buffers[1].loadState : undefined,
    "unloaded",
  );
  assert.equal(state.buffers[1]?.kind === "text" ? state.buffers[1].text : undefined, "");
  assert.equal(state.buffers[2]?.kind === "preview" ? state.buffers[2].preview : undefined, true);
});

test("loading restored text sets the disk baseline and keeps the preview tab state", () => {
  const previewId = filesFileBufferId(workspace, "/workspace/src/app.ts");
  const store = createFilesEditorStore();
  store.getState().hydrateSession({
    version: 1,
    activeId: previewId,
    openFileIds: [previewId],
    openTabs: [
      { id: previewId, kind: "text", path: "/workspace/src/app.ts", workspace, preview: true },
    ],
    drafts: [],
  });

  store.getState().setTextLoadState(previewId, "loading");
  store.getState().restoreTextContent(previewId, { text: "disk contents", truncated: false });

  const buffer = store.getState().buffers[0];
  assert.equal(buffer?.kind === "text" ? buffer.text : undefined, "disk contents");
  assert.equal(buffer?.kind === "text" ? buffer.savedText : undefined, "disk contents");
  assert.equal(buffer?.kind === "text" ? buffer.loadState : undefined, undefined);
  assert.equal(buffer?.kind === "text" ? buffer.preview : undefined, true);
});
