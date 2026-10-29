import assert from "node:assert/strict";
import test from "node:test";
import {
  createLargeTextFileBuffer,
  createPreviewBuffer,
  createTextFileBuffer,
  filesFileBufferId,
  isFilesBufferDirty,
} from "../src/files-workbench/filesEditorModel.js";
import { createFilesEditorStore } from "../src/files-workbench/filesEditorStore.js";
import type { FilesWorkspaceRef } from "../src/files-workbench/filesEditorTypes.js";
import {
  readCurrentFilesEditorPath,
  runFilesEditorFileOperation,
} from "../src/files-workbench/filesEditorFileIO.js";
import { getWorkspaceFileActionKey } from "../src/workspace-file-tree/fileActionRules.js";
import { useWorkspaceFileActionStore } from "../src/store/workspaceFileActionStore.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useFilesEditorRestore } from "../src/files-workbench/useFilesEditorRestore.js";

const workspace: FilesWorkspaceRef = { workspacePath: "/work" };

function text(path: string, content = path, scope = workspace) {
  return createTextFileBuffer({ workspace: scope, path, text: content });
}

function large(path: string, scope = workspace) {
  return createLargeTextFileBuffer({ workspace: scope, path, totalBytes: 32 });
}

function initLarge(
  store: ReturnType<typeof createFilesEditorStore>,
  buffer: ReturnType<typeof large>,
  text = "edited",
) {
  store.getState().openBuffer(buffer);
  store.getState().initializeLargeTextEdit(buffer.id, "v1", 32);
  store
    .getState()
    .updateLargeTextBlock(
      buffer.id,
      { blockIndex: 0, offset: 0, deleteBytes: 3, originalText: "old" },
      text,
    );
  const current = store.getState().buffers.find((item) => item.id === buffer.id)!;
  assert.ok(current.kind === "large-text");
  assert.equal(isFilesBufferDirty(current), true);
  return current;
}

test("删除不静默丢弃脏大文件：保留原路径、edit 与标签，只标记 deleted", () => {
  const store = createFilesEditorStore();
  const buffer = large("/work/huge.log");
  const dirty = initLarge(store, buffer);
  const editBefore = dirty.edit;

  store.getState().applyFileMutation({ workspace, kind: "delete", path: buffer.path });

  const next = store.getState();
  const kept = next.buffers.find((item) => item.id === buffer.id);
  assert.ok(kept?.kind === "large-text");
  assert.equal(kept.path, buffer.path);
  assert.equal(kept.edit, editBefore);
  assert.deepEqual(kept.externalChange, { kind: "deleted" });
  assert.equal(isFilesBufferDirty(kept), true);
  assert.equal(next.openIds.includes(buffer.id), true);
  assert.equal(
    Object.values(next.layout.groups)
      .flatMap((group) => group.views)
      .some((view) => view.bufferId === buffer.id),
    true,
  );
  assert.equal(
    next.buffers.some((item) => item.kind === "text" && item.untitled),
    false,
  );
});

test("重命名脏大文件迁移路径与 ID，保留 base/edit 并提示 changed", () => {
  const store = createFilesEditorStore();
  const buffer = large("/work/old.log");
  const dirty = initLarge(store, buffer);
  const newPath = "/work/new.log";
  const newId = filesFileBufferId(workspace, newPath);

  store.getState().applyFileMutation({ workspace, kind: "rename", path: buffer.path, newPath });

  const next = store.getState();
  assert.equal(
    next.buffers.some((item) => item.id === buffer.id),
    false,
  );
  const moved = next.buffers.find((item) => item.id === newId);
  assert.ok(moved?.kind === "large-text");
  assert.equal(moved.path, newPath);
  assert.equal(moved.edit, dirty.edit);
  assert.equal(moved.edit?.baseVersion, "v1");
  assert.equal(moved.edit?.changes.length, 1);
  assert.deepEqual(moved.externalChange, { kind: "changed" });
  assert.equal(isFilesBufferDirty(moved), true);
  assert.equal(next.openIds.includes(newId), true);
});

test("重命名干净大文件不标 changed，版本由后续 watch/restore 重探", () => {
  const store = createFilesEditorStore();
  const buffer = large("/work/clean.log");
  store.getState().openBuffer(buffer);
  store.getState().initializeLargeTextEdit(buffer.id, "v1", 32);
  const newPath = "/work/clean-renamed.log";

  store.getState().applyFileMutation({ workspace, kind: "rename", path: buffer.path, newPath });

  const moved = store
    .getState()
    .buffers.find((item) => item.id === filesFileBufferId(workspace, newPath));
  assert.ok(moved?.kind === "large-text");
  assert.equal(moved.path, newPath);
  assert.equal(moved.externalChange, undefined);
  // 干净大文件没有可保留的补丁，清掉旧 base，让 watch/restore 重新取得版本。
  assert.equal(moved.edit, undefined);
  assert.equal(isFilesBufferDirty(moved), false);
});

test("重命名撞上脏大文件时保留双方，拒绝迁移而不是覆盖目标", () => {
  const store = createFilesEditorStore();
  const source = large("/work/a.log");
  const target = large("/work/b.log");
  const sourceDirty = initLarge(store, source, "source edit");
  const targetDirty = initLarge(store, target, "target edit");
  const sourceId = source.id;
  const targetId = target.id;

  store
    .getState()
    .applyFileMutation({ workspace, kind: "rename", path: source.path, newPath: target.path });

  const next = store.getState();
  const keptSource = next.buffers.find((item) => item.id === sourceId);
  const keptTarget = next.buffers.find((item) => item.id === targetId);
  assert.ok(keptSource?.kind === "large-text");
  assert.ok(keptTarget?.kind === "large-text");
  assert.equal(keptSource.path, source.path);
  assert.equal(keptTarget.path, target.path);
  assert.equal(keptSource.edit, sourceDirty.edit);
  assert.equal(keptTarget.edit, targetDirty.edit);
  assert.deepEqual(keptSource.externalChange, { kind: "changed" });
  assert.deepEqual(keptTarget.externalChange, { kind: "changed" });
  assert.equal(isFilesBufferDirty(keptSource), true);
  assert.equal(isFilesBufferDirty(keptTarget), true);
  assert.equal(next.buffers.filter((item) => item.kind === "large-text").length, 2);
  assert.equal(new Set(next.buffers.map((item) => item.id)).size, next.buffers.length);
  assert.deepEqual([...next.openIds].sort(), [sourceId, targetId].sort());
  assert.equal(
    next.buffers.some((item) => item.kind === "text" && item.untitled),
    false,
  );
});

test("目录移动原子迁移脏缓冲、所有分屏、焦点及排队打开意图，并隔离工作区", () => {
  const store = createFilesEditorStore();
  const dirty = text("/work/src/app.ts");
  const preview = createPreviewBuffer({ workspace, path: "/work/src/image.png" });
  const other = text("/work/src/app.ts", "other", {
    ...workspace,
    workspaceIdentity: "another-workspace",
  });
  for (const buffer of [dirty, preview, other]) store.getState().openBuffer(buffer);
  store.getState().updateText(dirty.id, "unsaved");
  store.getState().setActiveId(dirty.id);
  const first = store.getState();
  const sourceGroup = first.layout.focusedGroupId;
  const view = first.layout.groups[sourceGroup]!.views.find(
    (entry) => entry.bufferId === dirty.id,
  )!;
  store.getState().splitViewToEdge(view.id, sourceGroup, "right", "copy");
  store.getState().requestOpenPath({ workspace, path: "/work/src/later.ts", focus: true });
  const pending = store.getState().pendingOpen!;
  assert.equal(store.getState().beginPendingOpen(pending), true);
  const focusedGroup = store.getState().layout.focusedGroupId;
  const focusedView = store.getState().layout.groups[focusedGroup]!.activeViewId;

  store
    .getState()
    .applyFileMutation({ workspace, kind: "move", path: "/work/src", newPath: "/work/lib" });

  const next = store.getState();
  const id = filesFileBufferId(workspace, "/work/lib/app.ts");
  const moved = next.buffers.find((buffer) => buffer.id === id)!;
  assert.equal(moved.kind, "text");
  assert.ok(moved.kind === "text");
  assert.equal(moved.path, "/work/lib/app.ts");
  assert.equal(moved.title, "app.ts");
  assert.equal(moved.text, "unsaved");
  assert.equal(moved.savedText, dirty.savedText);
  assert.equal(isFilesBufferDirty(moved), true);
  assert.equal(
    next.buffers.find((buffer) => buffer.id === other.id),
    other,
  );
  assert.equal(next.activeId, id);
  assert.equal(next.layout.focusedGroupId, focusedGroup);
  assert.equal(next.layout.groups[focusedGroup]!.activeViewId, focusedView);
  assert.equal(
    Object.values(next.layout.groups)
      .flatMap((group) => group.views)
      .filter((entry) => entry.bufferId === id).length,
    2,
  );
  assert.equal(
    next.buffers.some((buffer) => buffer.id === dirty.id || buffer.id === preview.id),
    false,
  );
  assert.equal(next.pendingOpen?.path, "/work/lib/later.ts");
  assert.equal(next.editorFocusRequest?.path, "/work/lib/later.ts");
  assert.equal(next.pendingOpenInFlight, undefined);
  assert.notEqual(next.pendingOpen, pending);
  next.completePendingOpen(pending);
  assert.equal(store.getState().pendingOpen?.path, "/work/lib/later.ts");
  const snapshot = store.getState().snapshotSession();
  assert.equal(snapshot.drafts.find((draft) => draft.id === id)?.text, "unsaved");
  assert.equal(snapshot.openFileIds.includes(dirty.id), false);
});

test("删除目录关闭干净标签，将空正文及普通脏文本保留为可恢复未命名草稿", () => {
  const store = createFilesEditorStore();
  const dirty = text("/work/src/dirty.ts", "saved");
  const emptied = text("/work/src/empty.ts", "not empty before edit");
  const clean = text("/work/src/clean.ts");
  const unrelated = text("/work/src-other/keep.ts");
  for (const buffer of [dirty, emptied, clean, unrelated]) store.getState().openBuffer(buffer);
  store.getState().updateText(dirty.id, "unsaved");
  store.getState().updateText(emptied.id, "");
  store.getState().setActiveId(dirty.id);
  const first = store.getState();
  const groupId = first.layout.focusedGroupId;
  const viewId = first.layout.groups[groupId]!.views.find((view) => view.bufferId === dirty.id)!.id;
  store.getState().splitViewToEdge(viewId, groupId, "right", "copy");
  store.getState().requestOpenPath({ workspace, path: "/work/src/deleted.ts", focus: true });
  const oldRequest = store.getState().pendingOpen!;
  store.getState().beginPendingOpen(oldRequest);
  store.getState().requestOpenPath({ workspace, path: unrelated.path! });

  store.getState().applyFileMutation({ workspace, kind: "delete", path: "/work/src" });

  const next = store.getState();
  const drafts = next.buffers.filter((buffer) => buffer.kind === "text" && buffer.untitled);
  assert.equal(drafts.length, 2);
  for (const draft of drafts) {
    assert.equal(draft.path, undefined);
    assert.equal(draft.preview, undefined);
    assert.equal(isFilesBufferDirty(draft), true);
  }
  assert.deepEqual(drafts.map((buffer) => buffer.kind === "text" && buffer.text).sort(), [
    "",
    "unsaved",
  ]);
  assert.equal(
    next.buffers.some((buffer) => buffer.id === clean.id),
    false,
  );
  assert.equal(
    next.buffers.find((buffer) => buffer.id === unrelated.id),
    unrelated,
  );
  assert.equal(next.pendingOpen?.path, unrelated.path);
  assert.equal(next.pendingOpenInFlight, undefined);
  assert.equal(next.editorFocusRequest, undefined);
  const recovered = createFilesEditorStore();
  recovered.getState().hydrateSession(next.snapshotSession());
  assert.equal(recovered.getState().buffers.filter(isFilesBufferDirty).length, 2);
  assert.ok(
    Object.values(next.layout.groups)
      .flatMap((group) => group.views)
      .every((view) => next.buffers.some((buffer) => buffer.id === view.bufferId)),
  );
  assert.equal(
    Object.values(next.layout.groups)
      .flatMap((group) => group.views)
      .filter((view) => view.id === viewId).length,
    1,
  );
});

test("目标路径残留脏缓冲时保留双方正文，目标旧内容转为未命名草稿", () => {
  const store = createFilesEditorStore();
  const source = text("/work/a.ts", "source saved");
  const target = text("/work/b.ts", "target saved");
  store.getState().openBuffer(source);
  store.getState().updateText(source.id, "source edit");
  store.getState().openBuffer(target);
  store.getState().updateText(target.id, "target edit");
  const targetView =
    store.getState().layout.groups[store.getState().layout.focusedGroupId]!.activeViewId;
  store
    .getState()
    .applyFileMutation({ workspace, kind: "rename", path: source.path!, newPath: target.path });
  const next = store.getState();
  const canonical = next.buffers.find((buffer) => buffer.id === target.id)!;
  assert.ok(canonical.kind === "text");
  assert.equal(canonical.text, "source edit");
  assert.equal(canonical.savedText, "source saved");
  const rescued = next.buffers.find((buffer) => buffer.kind === "text" && buffer.untitled)!;
  assert.ok(rescued.kind === "text");
  assert.equal(rescued.text, "target edit");
  assert.equal(rescued.savedText, "target saved");
  assert.equal(
    next.layout.groups[next.layout.focusedGroupId]!.views.find((view) => view.id === targetView)
      ?.bufferId,
    rescued.id,
  );
  assert.equal(new Set(next.buffers.map((buffer) => buffer.id)).size, next.buffers.length);
});

test("Windows目录边界和远程会话隔离均不误迁移相邻路径", () => {
  const store = createFilesEditorStore();
  const remote: FilesWorkspaceRef = {
    workspacePath: "C:\\work",
    workspaceIdentity: "remote",
    workspaceRemoteSessionId: "one",
  };
  const source = text("C:\\work\\src\\a.ts", "saved", remote);
  const sibling = text("C:\\work\\src-other\\b.ts", "keep", remote);
  store.getState().openBuffer(source);
  store.getState().openBuffer(sibling);
  store.getState().applyFileMutation({
    workspace: { ...remote, workspaceRemoteSessionId: "two" },
    kind: "delete",
    path: "C:\\work\\src",
  });
  assert.equal(store.getState().buffers.length, 2);
  store.getState().applyFileMutation({
    workspace: remote,
    kind: "rename",
    path: "C:\\work\\src",
    newPath: "C:\\work\\renamed",
  });
  assert.equal(
    store.getState().buffers.find((buffer) => buffer.id !== sibling.id)?.path,
    "C:\\work\\renamed\\a.ts",
  );
  assert.equal(
    store.getState().buffers.find((buffer) => buffer.id === sibling.id),
    sibling,
  );
});

test("改名使在途旧读取失效；旧完成不能消费迁移后的待打开意图", async () => {
  const store = createFilesEditorStore();
  store.getState().requestOpenPath({ workspace, path: "/work/old.ts", focus: true });
  const request = store.getState().pendingOpen!;
  store.getState().beginPendingOpen(request);
  let resolveRead!: (value: string) => void;
  const oldRead = readCurrentFilesEditorPath({
    store,
    workspace,
    path: request.path,
    request,
    read: () =>
      new Promise<string>((resolve) => {
        resolveRead = resolve;
      }),
  });
  store
    .getState()
    .applyFileMutation({ workspace, kind: "rename", path: request.path, newPath: "/work/new.ts" });
  resolveRead("old result");
  assert.equal(await oldRead, null);
  store.getState().completePendingOpen(request);
  const migrated = store.getState().pendingOpen!;
  assert.equal(migrated.path, "/work/new.ts");
  assert.equal(store.getState().beginPendingOpen(migrated), true);
  assert.equal(
    await readCurrentFilesEditorPath({
      store,
      workspace,
      path: migrated.path,
      request: migrated,
      read: async () => "new result",
    }),
    "new result",
  );
});

test("直接打开的在途读取在删除后失效，其它工作区变更不影响结果", async () => {
  const store = createFilesEditorStore();
  let resolveRead!: (value: string) => void;
  const read = readCurrentFilesEditorPath({
    store,
    workspace,
    path: "/work/a.ts",
    read: () =>
      new Promise<string>((resolve) => {
        resolveRead = resolve;
      }),
  });
  store.getState().applyFileMutation({
    workspace: { ...workspace, workspaceIdentity: "other" },
    kind: "delete",
    path: "/work/a.ts",
  });
  resolveRead("valid");
  assert.equal(await read, "valid");
  let resolveDeleted!: (value: string) => void;
  const deletedRead = readCurrentFilesEditorPath({
    store,
    workspace,
    path: "/work/a.ts",
    read: () =>
      new Promise<string>((resolve) => {
        resolveDeleted = resolve;
      }),
  });
  store.getState().applyFileMutation({ workspace, kind: "delete", path: "/work/a.ts" });
  resolveDeleted("stale");
  assert.equal(await deletedRead, null);
});

test("保存与文件变更共用单一工作区准入，完成及抛错都会释放", async () => {
  const key = getWorkspaceFileActionKey(workspace);
  const actions = useWorkspaceFileActionStore.getState();
  let release!: () => void;
  const saving = runFilesEditorFileOperation(
    workspace,
    () =>
      new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      }),
  );
  assert.equal(actions.beginOperation(key), false);
  let ran = false;
  assert.equal(
    await runFilesEditorFileOperation(workspace, async () => {
      ran = true;
      return true;
    }),
    false,
  );
  assert.equal(ran, false);
  release();
  assert.equal(await saving, true);
  assert.equal(actions.beginOperation(key), true);
  actions.endOperation(key);
  await assert.rejects(
    runFilesEditorFileOperation(workspace, async () => {
      throw new Error("failed");
    }),
  );
  assert.equal(actions.beginOperation(key), true);
  actions.endOperation(key);
});

test("保存完成只推进磁盘基准，等待期间的编辑继续保持脏态", () => {
  const store = createFilesEditorStore();
  const buffer = text("/work/edit.ts", "before save");
  store.getState().openBuffer(buffer);
  store.getState().updateText(buffer.id, "submitted text");
  store.getState().updateText(buffer.id, "typed while saving");
  store.getState().markSaved(buffer.id, {
    workspace,
    path: buffer.path!,
    text: "submitted text",
    preserveCurrentText: true,
  });
  const saved = store.getState().buffers[0]!;
  assert.ok(saved.kind === "text");
  assert.equal(saved.text, "typed while saving");
  assert.equal(saved.savedText, "submitted text");
  assert.equal(isFilesBufferDirty(saved), true);
  store
    .getState()
    .applyFileMutation({ workspace, kind: "rename", path: buffer.path!, newPath: "/work/new.ts" });
  store
    .getState()
    .markSaved(buffer.id, { workspace, path: buffer.path!, text: "stale completion" });
  assert.equal(
    store.getState().buffers.some((candidate) => candidate.path === buffer.path),
    false,
  );
  assert.equal(store.getState().buffers.length, 1);
});

test("A到B再到A后，最早恢复读取的成功及失败都不能污染新的A", async () => {
  for (const fail of [false, true]) {
    const store = createFilesEditorStore();
    const buffer = { ...text("/work/a.ts", ""), loadState: "loading" as const };
    store.getState().openBuffer(buffer);
    let resolveRead!: (value: string) => void;
    let rejectRead!: (error: Error) => void;
    let accepted = false;
    let rejected = false;
    const read = readCurrentFilesEditorPath({
      store,
      workspace,
      path: buffer.path!,
      read: () =>
        new Promise<string>((resolve, reject) => {
          resolveRead = resolve;
          rejectRead = reject;
        }),
      accept: () => {
        accepted = true;
      },
      reject: () => {
        rejected = true;
        store.getState().setTextLoadState(buffer.id, "error");
      },
    });
    store
      .getState()
      .applyFileMutation({ workspace, kind: "rename", path: "/work/a.ts", newPath: "/work/b.ts" });
    store
      .getState()
      .applyFileMutation({ workspace, kind: "rename", path: "/work/b.ts", newPath: "/work/a.ts" });
    store.getState().setTextLoadState(buffer.id, "loading");
    if (fail) rejectRead(new Error("old read failed"));
    else resolveRead("stale text");
    assert.equal(await read, null);
    assert.equal(accepted, false);
    assert.equal(rejected, false);
    const current = store.getState().buffers[0]!;
    assert.ok(current.kind === "text");
    assert.equal(current.loadState, "loading");
    assert.equal(current.text, "");
  }
});

test("恢复加载A到B再到A后能继续读取新A，不被旧ID的在途Promise永久阻塞", async () => {
  const store = createFilesEditorStore();
  const buffer = { ...text("/work/a.ts", ""), loadState: "unloaded" as const };
  store.getState().openBuffer(buffer);
  let resolveOld!: (value: ReturnType<typeof windowFor>) => void;
  let reads = 0;
  const windowFor = (content: string) => ({
    path: "/work/a.ts",
    content,
    offset: 0,
    bytesRead: content.length,
    nextOffset: content.length,
    totalBytes: content.length,
    version: `v-${content.length}`,
    isBinary: false,
    eof: true,
    truncated: false,
  });
  let loader!: ReturnType<typeof useFilesEditorRestore>;
  function CaptureLoader() {
    loader = useFilesEditorRestore({
      store,
      restoreEnabled: false,
      persist: () => undefined,
      resolveServices: () => ({
        fileService: {
          readTextFileWindow: async () => {
            reads++;
            if (reads === 1)
              return new Promise<ReturnType<typeof windowFor>>((resolve) => {
                resolveOld = resolve;
              });
            return windowFor("current A");
          },
        },
      }),
    });
    return null;
  }
  renderToStaticMarkup(createElement(CaptureLoader));
  const old = loader.loadRestoredTextFile(buffer.id);
  await Promise.resolve();
  store
    .getState()
    .applyFileMutation({ workspace, kind: "rename", path: "/work/a.ts", newPath: "/work/b.ts" });
  store
    .getState()
    .applyFileMutation({ workspace, kind: "rename", path: "/work/b.ts", newPath: "/work/a.ts" });
  assert.equal(loader.loadRestoredTextFile(buffer.id), old);
  resolveOld(windowFor("stale A"));
  await old;
  await Promise.resolve();
  assert.equal(reads, 2);
  await loader.loadRestoredTextFile(buffer.id);
  const current = store.getState().buffers[0]!;
  assert.ok(current.kind === "text");
  assert.equal(current.text, "current A");
  assert.equal(current.loadState, undefined);
});
