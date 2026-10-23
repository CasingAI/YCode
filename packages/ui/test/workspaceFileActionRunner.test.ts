import assert from "node:assert/strict";
import test from "node:test";
import type * as Monaco from "monaco-editor";
import {
  createTextFileBuffer,
  filesFileBufferId,
} from "../src/files-workbench/filesEditorModel.js";
import {
  disposeFilesMonacoModel,
  getOrCreateFilesMonacoModel,
} from "../src/files-workbench/filesMonacoModels.js";
import { createFilesEditorStore } from "../src/files-workbench/filesEditorStore.js";
import type { FilesWorkspaceRef } from "../src/files-workbench/filesEditorTypes.js";
import { useWorkspaceFileActionStore } from "../src/store/workspaceFileActionStore.js";
import { getWorkspaceFileActionKey } from "../src/workspace-file-tree/fileActionRules.js";
import {
  runWorkspaceFileMutation,
  type WorkspaceFileMutationResult,
} from "../src/workspace-file-tree/workspaceFileActionRunner.js";

const workspace: FilesWorkspaceRef = { workspacePath: "/work", workspaceIdentity: "workspace-a" };

function resetActionStore() {
  useWorkspaceFileActionStore.setState({ clipboard: null, busyWorkspaceKeys: [] });
}

function createEditor(scope = workspace) {
  const editorStore = createFilesEditorStore();
  const buffer = createTextFileBuffer({ workspace: scope, path: "/work/src/a.ts", text: "saved" });
  editorStore.getState().openBuffer(buffer);
  editorStore.getState().updateText(buffer.id, "unsaved");
  return { editorStore, buffer };
}

function copy(path = "/work/src/a.ts", scope = workspace, operation: "copy" | "cut" = "copy") {
  return useWorkspaceFileActionStore.getState().setClipboard({
    operation,
    workspacePath: scope.workspacePath,
    workspaceIdentity: scope.workspaceIdentity,
    remoteSessionId: scope.workspaceRemoteSessionId,
    path,
    type: "file",
    name: path.split("/").at(-1)!,
  });
}

function deferredResult() {
  let resolve!: (value: WorkspaceFileMutationResult) => void;
  const result = new Promise<WorkspaceFileMutationResult>((done) => {
    resolve = done;
  });
  return { result, resolve };
}

test("文件变更等待 Host 成功后迁移原工作区脏缓冲并持久化", async () => {
  resetActionStore();
  const { editorStore, buffer } = createEditor();
  const deferred = deferredResult();
  const calls: unknown[] = [];
  const persisted: string[] = [];
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: { setItem: (_key: string, value: string) => persisted.push(value) } },
  });
  try {
    const mutation = { kind: "rename", path: "/work/src", name: "lib" } as const;
    const running = runWorkspaceFileMutation({
      workspace,
      editorStore,
      mutation,
      fileService: {
        mutateWorkspaceEntry: (params) => {
          calls.push(params);
          return deferred.result;
        },
      },
    });
    assert.deepEqual(calls, [{ rootPath: "/work", workspaceIdentity: "workspace-a", mutation }]);
    assert.equal(editorStore.getState().buffers[0]?.path, buffer.path);
    assert.equal(persisted.length, 0);
    deferred.resolve({
      path: "/work/lib",
      previousPath: "/work/src",
      type: "directory",
      changed: true,
    });
    const result = await running;
    assert.equal(result.path, "/work/lib");
    const moved = editorStore.getState().buffers[0]!;
    assert.equal(moved.path, "/work/lib/a.ts");
    assert.equal(moved.id, filesFileBufferId(workspace, "/work/lib/a.ts"));
    assert.ok(moved.kind === "text");
    assert.equal(moved.text, "unsaved");
    assert.equal(moved.savedText, "saved");
    assert.equal(persisted.length, 1);
    assert.equal(JSON.parse(persisted[0]!).drafts[0].path, "/work/lib/a.ts");
    assert.deepEqual(useWorkspaceFileActionStore.getState().busyWorkspaceKeys, []);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("失败不协调缓冲、不消费剪贴板并释放同工作区准入", async () => {
  resetActionStore();
  const { editorStore } = createEditor();
  const id = copy(undefined, workspace, "cut");
  const before = editorStore.getState();
  const error = new Error("Host rejected mutation");
  await assert.rejects(
    runWorkspaceFileMutation({
      workspace,
      editorStore,
      mutation: { kind: "move", path: "/work/src/a.ts", targetDirectory: "/work/lib" },
      clipboardId: id,
      fileService: {
        mutateWorkspaceEntry: async () => {
          throw error;
        },
      },
    }),
    error,
  );
  assert.equal(editorStore.getState(), before);
  assert.equal(useWorkspaceFileActionStore.getState().clipboard?.id, id);
  assert.deepEqual(useWorkspaceFileActionStore.getState().busyWorkspaceKeys, []);
});

test("保存或另一变更已占用同scope时不发送IO，不释放别人的锁", async () => {
  resetActionStore();
  const { editorStore } = createEditor();
  const key = getWorkspaceFileActionKey(workspace);
  useWorkspaceFileActionStore.getState().beginOperation(key);
  let calls = 0;
  await assert.rejects(
    runWorkspaceFileMutation({
      workspace,
      editorStore,
      mutation: { kind: "delete", path: "/work/src" },
      fileService: {
        mutateWorkspaceEntry: async () => {
          calls++;
          throw new Error("must not run");
        },
      },
    }),
    /workspace-file-operation-busy/,
  );
  assert.equal(calls, 0);
  assert.deepEqual(useWorkspaceFileActionStore.getState().busyWorkspaceKeys, [key]);
  useWorkspaceFileActionStore.getState().endOperation(key);
});

test("在途移动保留新复制项，同父目录无操作移动也消费对应剪切项", async () => {
  resetActionStore();
  const { editorStore } = createEditor();
  const id = copy(undefined, workspace, "cut");
  const deferred = deferredResult();
  const running = runWorkspaceFileMutation({
    workspace,
    editorStore,
    mutation: { kind: "move", path: "/work/src/a.ts", targetDirectory: "/work/lib" },
    clipboardId: id,
    fileService: { mutateWorkspaceEntry: () => deferred.result },
  });
  const newId = copy("/work/new.ts");
  deferred.resolve({
    path: "/work/lib/a.ts",
    previousPath: "/work/src/a.ts",
    type: "file",
    changed: true,
  });
  await running;
  assert.equal(useWorkspaceFileActionStore.getState().clipboard?.id, newId);

  const cutId = copy("/work/lib/a.ts", workspace, "cut");
  const stateBeforeNoOp = editorStore.getState();
  await runWorkspaceFileMutation({
    workspace,
    editorStore,
    mutation: { kind: "move", path: "/work/lib/a.ts", targetDirectory: "/work/lib" },
    clipboardId: cutId,
    fileService: {
      mutateWorkspaceEntry: async () => ({ path: "/work/lib/a.ts", type: "file", changed: false }),
    },
  });
  assert.equal(useWorkspaceFileActionStore.getState().clipboard, null);
  assert.equal(editorStore.getState(), stateBeforeNoOp);
});

test("复制后保留剪贴板，move不能消费copy或未指定id的项", async () => {
  resetActionStore();
  const { editorStore } = createEditor();
  const id = copy();
  const fileService = {
    mutateWorkspaceEntry: async () => ({
      path: "/work/src/a copy.ts",
      type: "file" as const,
      changed: true,
    }),
  };
  await runWorkspaceFileMutation({
    workspace,
    editorStore,
    fileService,
    clipboardId: id,
    mutation: { kind: "copy", path: "/work/src/a.ts", targetDirectory: "/work/src" },
  });
  assert.equal(useWorkspaceFileActionStore.getState().clipboard?.id, id);
  await runWorkspaceFileMutation({
    workspace,
    editorStore,
    fileService,
    clipboardId: id,
    mutation: { kind: "move", path: "/work/src/a.ts", targetDirectory: "/work/lib" },
  });
  assert.equal(useWorkspaceFileActionStore.getState().clipboard?.id, id);
  const cutId = copy(undefined, workspace, "cut");
  await runWorkspaceFileMutation({
    workspace,
    editorStore,
    fileService,
    mutation: { kind: "move", path: "/work/src/a.ts", targetDirectory: "/work/lib" },
  });
  assert.equal(useWorkspaceFileActionStore.getState().clipboard?.id, cutId);
});

test("改名和删除清理已失效源的当前剪贴板，保留相邻路径与其他身份和会话", async () => {
  for (const kind of ["rename", "delete"] as const) {
    resetActionStore();
    const { editorStore } = createEditor();
    const mutation =
      kind === "rename" ? { kind, path: "/work/src", name: "lib" } : { kind, path: "/work/src" };
    const run = () =>
      runWorkspaceFileMutation({
        workspace,
        editorStore,
        mutation,
        fileService: {
          mutateWorkspaceEntry: async () => ({
            path: "/work/lib",
            previousPath: "/work/src",
            type: "directory",
            changed: true,
          }),
        },
      });
    copy();
    await run();
    assert.equal(useWorkspaceFileActionStore.getState().clipboard, null);
    for (const [path, scope] of [
      ["/work/src-other/a.ts", workspace],
      ["/work/src/a.ts", { ...workspace, workspaceIdentity: "workspace-b" }],
      ["/work/src/a.ts", { ...workspace, workspaceRemoteSessionId: "other-session" }],
    ] as const) {
      const id = copy(path, scope);
      await run();
      assert.equal(useWorkspaceFileActionStore.getState().clipboard?.id, id);
    }
  }
});

test("切换工作区后旧结果只协调原scope，不清新scope剪贴板或抢占其锁", async () => {
  resetActionStore();
  const { editorStore, buffer } = createEditor();
  const otherWorkspace = { ...workspace, workspaceIdentity: "workspace-b" };
  const other = createTextFileBuffer({
    workspace: otherWorkspace,
    path: "/work/src/a.ts",
    text: "other",
  });
  editorStore.getState().openBuffer(other);
  const deferred = deferredResult();
  const running = runWorkspaceFileMutation({
    workspace,
    editorStore,
    mutation: { kind: "delete", path: "/work/src" },
    fileService: { mutateWorkspaceEntry: () => deferred.result },
  });
  const otherKey = getWorkspaceFileActionKey(otherWorkspace);
  assert.equal(useWorkspaceFileActionStore.getState().beginOperation(otherKey), true);
  const id = copy("/work/src/a.ts", otherWorkspace);
  deferred.resolve({ path: "/work/src", type: "directory", changed: true });
  await running;
  assert.equal(
    editorStore.getState().buffers.some((entry) => entry.id === buffer.id),
    false,
  );
  assert.equal(
    editorStore.getState().buffers.find((entry) => entry.id === other.id),
    other,
  );
  assert.equal(editorStore.getState().activeId, other.id);
  assert.equal(useWorkspaceFileActionStore.getState().clipboard?.id, id);
  assert.deepEqual(useWorkspaceFileActionStore.getState().busyWorkspaceKeys, [otherKey]);
  useWorkspaceFileActionStore.getState().endOperation(otherKey);
});

test("远程会话变更与同会话保存共用锁，同路径另一会话可独立准入", async () => {
  resetActionStore();
  const remote = { ...workspace, workspaceRemoteSessionId: "session-a" };
  const { editorStore } = createEditor(remote);
  const key = getWorkspaceFileActionKey({
    workspacePath: remote.workspacePath,
    workspaceIdentity: remote.workspaceIdentity,
    remoteSessionId: remote.workspaceRemoteSessionId,
  });
  const otherKey = getWorkspaceFileActionKey({
    workspacePath: remote.workspacePath,
    workspaceIdentity: remote.workspaceIdentity,
    remoteSessionId: "session-b",
  });
  const deferred = deferredResult();
  const running = runWorkspaceFileMutation({
    workspace: remote,
    editorStore,
    mutation: { kind: "delete", path: "/work/src" },
    fileService: { mutateWorkspaceEntry: () => deferred.result },
  });
  assert.equal(useWorkspaceFileActionStore.getState().beginOperation(key), false);
  assert.equal(useWorkspaceFileActionStore.getState().beginOperation(otherKey), true);
  deferred.resolve({ path: "/work/src", type: "directory", changed: true });
  await running;
  assert.deepEqual(useWorkspaceFileActionStore.getState().busyWorkspaceKeys, [otherKey]);
  useWorkspaceFileActionStore.getState().endOperation(otherKey);
});

test("改名和删除释放已移除ID的Monaco模型，保留其他模型及迁移后的脏正文", async () => {
  const registry = new Map<string, Monaco.editor.ITextModel>();
  const monaco = {
    Uri: {
      file: (path: string) => ({ toString: () => `file://${path}` }),
      parse: (value: string) => ({ toString: () => value }),
    },
    editor: {
      getModel: (uri: { toString: () => string }) => registry.get(uri.toString()),
      createModel: (value: string, languageId: string, uri: { toString: () => string }) => {
        let disposed = false;
        const model = {
          uri,
          getValue: () => value,
          getLanguageId: () => languageId,
          isDisposed: () => disposed,
          dispose: () => {
            disposed = true;
            registry.delete(uri.toString());
          },
        } as unknown as Monaco.editor.ITextModel;
        registry.set(uri.toString(), model);
        return model;
      },
      setModelLanguage: () => {},
    },
  } as unknown as typeof Monaco;

  for (const kind of ["rename", "delete"] as const) {
    resetActionStore();
    const { editorStore, buffer } = createEditor();
    const unrelated = createTextFileBuffer({ workspace, path: "/work/keep.ts", text: "keep" });
    editorStore.getState().openBuffer(unrelated);
    const oldModel = getOrCreateFilesMonacoModel(
      monaco,
      buffer.id,
      "unsaved",
      buffer.path,
      workspace,
    );
    const keptModel = getOrCreateFilesMonacoModel(
      monaco,
      unrelated.id,
      "keep",
      unrelated.path,
      workspace,
    );
    try {
      await runWorkspaceFileMutation({
        workspace,
        editorStore,
        mutation:
          kind === "rename"
            ? { kind, path: "/work/src", name: "lib" }
            : { kind, path: "/work/src" },
        fileService: {
          mutateWorkspaceEntry: async () => ({
            path: "/work/lib",
            previousPath: "/work/src",
            type: "directory",
            changed: true,
          }),
        },
      });
      assert.equal(oldModel.isDisposed(), true);
      assert.equal(keptModel.isDisposed(), false);
      const migrated = editorStore.getState().buffers.find((entry) => entry.id !== unrelated.id)!;
      assert.ok(migrated.kind === "text");
      assert.notEqual(migrated.id, buffer.id);
      assert.equal(migrated.text, "unsaved");
      assert.equal(migrated.savedText, "saved");
    } finally {
      disposeFilesMonacoModel(buffer.id);
      disposeFilesMonacoModel(unrelated.id);
    }
  }
});
