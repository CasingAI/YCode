import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileTextWindow } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { TabStoreProvider } from "../src/store/TabStoreProvider.js";
import {
  FilesEditorStoreProvider,
  useFilesEditorStoreApi,
} from "../src/files-workbench/FilesEditorStoreProvider.js";
import { commitFilesEditorTextReadResult } from "../src/files-workbench/filesEditorFileIO.js";
import { useFilesWorkbenchController } from "../src/files-workbench/useFilesWorkbenchController.js";
import { useFilesEditorRestore } from "../src/files-workbench/useFilesEditorRestore.js";
import {
  canSaveFilesBuffer,
  createTextFileBuffer,
  filesFileBufferId,
  isFilesBufferDirty,
} from "../src/files-workbench/filesEditorModel.js";
import { createFilesEditorStore } from "../src/files-workbench/filesEditorStore.js";
import type { FilesEditorStore } from "../src/files-workbench/filesEditorStore.js";
import type {
  FilesPersistedSession,
  FilesWorkspaceRef,
} from "../src/files-workbench/filesEditorTypes.js";

const workspace: FilesWorkspaceRef = { workspacePath: "/work" };

function textWindow(path: string, content: string, isBinary = false): FileTextWindow {
  return {
    path,
    content: isBinary ? "" : content,
    offset: 0,
    bytesRead: content.length,
    nextOffset: content.length,
    totalBytes: content.length,
    version: `v-${content.length}`,
    isBinary,
    eof: true,
    truncated: false,
  };
}

function readResult(path: string, content: string, isBinary = false) {
  const window = textWindow(path, content, isBinary);
  return isBinary
    ? { mode: "binary" as const, totalBytes: window.totalBytes, version: window.version }
    : {
        mode: "editable" as const,
        text: window.content,
        totalBytes: window.totalBytes,
        version: window.version,
      };
}

function servicesWith(
  readTextFileWindow: (args: {
    path: string;
    offset?: number;
    length?: number;
    expectedVersion?: string;
  }) => Promise<FileTextWindow>,
): IServiceAccessor {
  return { fileService: { readTextFileWindow } } as unknown as IServiceAccessor;
}

function renderController(services: IServiceAccessor) {
  let captured!: {
    controller: ReturnType<typeof useFilesWorkbenchController>;
    store: FilesEditorStore;
  };
  function Capture() {
    captured = {
      controller: useFilesWorkbenchController(false, false),
      store: useFilesEditorStoreApi(),
    };
    return null;
  }
  renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(
        ServiceProvider,
        { services },
        createElement(
          TabStoreProvider,
          null,
          createElement(FilesEditorStoreProvider, null, createElement(Capture)),
        ),
      ),
    ),
  );
  return captured;
}

function captureRestore(
  store: FilesEditorStore,
  services: IServiceAccessor,
  persist: () => void = () => undefined,
) {
  let loader!: ReturnType<typeof useFilesEditorRestore>;
  function Capture() {
    loader = useFilesEditorRestore({
      store,
      restoreEnabled: false,
      persist,
      resolveServices: () => services,
    });
    return null;
  }
  renderToStaticMarkup(createElement(Capture));
  return loader;
}

function sessionWithTabs(params: {
  tabs: NonNullable<FilesPersistedSession["openTabs"]>;
  drafts?: FilesPersistedSession["drafts"];
  activeId?: string;
}): FilesPersistedSession {
  const openFileIds = params.tabs
    .map((tab) => tab.id)
    .concat((params.drafts ?? []).map((draft) => draft.id));
  return {
    version: 1,
    activeId: params.activeId ?? openFileIds[0],
    openFileIds,
    openTabs: params.tabs,
    drafts: params.drafts ?? [],
  };
}

test("首开未知二进制的文本候选时建立预览标签，不留下可保存的空文本缓冲", async () => {
  const path = "/work/assets/blob.unknownext";
  const reads: string[] = [];
  const { controller, store } = renderController(
    servicesWith(async (args) => {
      reads.push(args.path);
      return textWindow(args.path, "\u0000\u0001binary", true);
    }),
  );

  await controller.openExistingPath(workspace, path);

  const state = store.getState();
  const id = filesFileBufferId(workspace, path);
  assert.equal(state.buffers.length, 1);
  const buffer = state.buffers[0]!;
  assert.equal(buffer.kind, "preview");
  assert.equal(buffer.id, id);
  assert.equal(buffer.path, path);
  assert.equal(buffer.preview, undefined);
  assert.equal(canSaveFilesBuffer(buffer), false);
  assert.deepEqual(state.openIds, [id]);
  assert.equal(state.activeId, id);
  const group = state.layout.groups[state.layout.focusedGroupId]!;
  assert.deepEqual(
    group.views.map((view) => view.bufferId),
    [id],
  );
  assert.equal(
    state.buffers.some((candidate) => candidate.kind === "text"),
    false,
  );
  assert.deepEqual(reads, [path]);
  // 只建立预览标签；持久化元数据也必须是 preview，重启后无需再猜一次。
  assert.equal(state.snapshotSession().openTabs[0]?.kind, "preview");
});

test("恢复未知二进制时在原缓冲 ID 内转为预览，保留预览标记、顺序、焦点与分屏拓扑", async () => {
  const aPath = "/work/a.ts";
  const binaryPath = "/work/assets/blob.unknownext";
  const bPath = "/work/b.ts";
  const aId = filesFileBufferId(workspace, aPath);
  const binaryId = filesFileBufferId(workspace, binaryPath);
  const bId = filesFileBufferId(workspace, bPath);
  const store = createFilesEditorStore();
  store.getState().hydrateSession(
    sessionWithTabs({
      activeId: binaryId,
      tabs: [
        { id: aId, kind: "text", path: aPath, workspace },
        { id: binaryId, kind: "text", path: binaryPath, workspace, preview: true },
        { id: bId, kind: "text", path: bPath, workspace },
      ],
    }),
  );
  // 把二进制的活动视图分屏复制，模拟用户已有的布局与焦点。
  const hydrated = store.getState();
  const sourceGroupId = hydrated.layout.focusedGroupId;
  const binaryView = hydrated.layout.groups[sourceGroupId]!.views.find(
    (view) => view.bufferId === binaryId,
  )!;
  store.getState().splitViewToEdge(binaryView.id, sourceGroupId, "right", "copy");

  const before = store.getState();
  const layoutBefore = before.layout;
  const openIdsBefore = before.openIds;
  const reads: string[] = [];
  const loader = captureRestore(
    store,
    servicesWith(async (args) => {
      reads.push(args.path);
      return textWindow(args.path, "\u0000binary", true);
    }),
  );

  await loader.loadRestoredTextFile(binaryId);

  const after = store.getState();
  const converted = after.buffers.find((buffer) => buffer.id === binaryId)!;
  assert.equal(converted.kind, "preview");
  assert.equal(converted.preview, true);
  assert.equal(converted.path, binaryPath);
  assert.equal(converted.workspace, workspace);
  // 同一 ID、同一布局与焦点，不能靠关闭再打开重建标签。
  assert.deepEqual(after.layout, layoutBefore);
  assert.deepEqual(after.openIds, openIdsBefore);
  assert.equal(after.activeId, binaryId);
  assert.equal(
    after.buffers.some((buffer) => buffer.kind === "text" && buffer.loadState !== undefined),
    true,
  );
  assert.deepEqual(reads, [binaryPath]);
});

test("恢复旧会话中干净图片的 text 元数据时直接按当前分类修正为预览且不读盘", () => {
  const imagePath = "/work/assets/logo.png";
  const imageId = filesFileBufferId(workspace, imagePath);
  const textId = filesFileBufferId(workspace, "/work/src/app.ts");
  const store = createFilesEditorStore();

  store.getState().hydrateSession(
    sessionWithTabs({
      activeId: imageId,
      tabs: [
        { id: textId, kind: "text", path: "/work/src/app.ts", workspace },
        // 旧版本错误地把图片记成 text；恢复时必须按当前共用分类纠正。
        { id: imageId, kind: "text", path: imagePath, workspace, preview: true },
      ],
    }),
  );

  const state = store.getState();
  const image = state.buffers.find((buffer) => buffer.id === imageId)!;
  assert.equal(image.kind, "preview");
  assert.equal(image.preview, true);
  assert.deepEqual(state.openIds, [textId, imageId]);
  assert.equal(state.activeId, imageId);
  assert.deepEqual(
    state.layout.groups[state.layout.focusedGroupId]?.views.map((view) => view.bufferId),
    [textId, imageId],
  );
  assert.equal(state.snapshotSession().openTabs.find((tab) => tab.id === imageId)?.kind, "preview");
});

test("脏草稿优先于路径分类与读盘：图片误开产生的草稿绝不被改成预览", async () => {
  const imagePath = "/work/assets/logo.png";
  const imageId = filesFileBufferId(workspace, imagePath);
  let reads = 0;
  const { controller, store } = renderController(
    servicesWith(async (args) => {
      reads += 1;
      return textWindow(args.path, "should not be read", true);
    }),
  );
  store.getState().hydrateSession({
    version: 1,
    activeId: imageId,
    openFileIds: [imageId],
    openTabs: [{ id: imageId, kind: "text", path: imagePath, workspace }],
    drafts: [
      {
        id: imageId,
        path: imagePath,
        title: "logo.png",
        text: "unsaved draft",
        savedText: "saved draft",
        workspace,
        untitled: false,
      },
    ],
  });

  await controller.openExistingPath(workspace, imagePath);

  const state = store.getState();
  const buffer = state.buffers.find((candidate) => candidate.id === imageId)!;
  assert.equal(buffer.kind, "text");
  assert.ok(buffer.kind === "text");
  assert.equal(buffer.text, "unsaved draft");
  assert.equal(isFilesBufferDirty(buffer), true);
  assert.equal(reads, 0);
});

test("已打开干净文本缓冲重开时按当前分类原地改为预览，不重新读盘也不改变拓扑", async () => {
  const path = "/work/docs/report.pdf";
  const id = filesFileBufferId(workspace, path);
  let reads = 0;
  const { controller, store } = renderController(
    servicesWith(async (args) => {
      reads += 1;
      return textWindow(args.path, "text", false);
    }),
  );
  store.getState().openBuffer(createTextFileBuffer({ workspace, path, text: "legacy text" }));
  const before = store.getState();
  const viewIdsBefore = Object.values(before.layout.groups).flatMap((group) =>
    group.views.map((view) => view.id),
  );

  await controller.openExistingPath(workspace, path);

  const after = store.getState();
  const buffer = after.buffers.find((candidate) => candidate.id === id)!;
  assert.equal(buffer.kind, "preview");
  assert.equal(buffer.preview, undefined);
  assert.deepEqual(after.openIds, [id]);
  assert.deepEqual(
    Object.values(after.layout.groups).flatMap((group) => group.views.map((view) => view.id)),
    viewIdsBefore,
  );
  assert.equal(reads, 0);
});

test("恢复读取期间删除路径后，旧二进制结果不得重新建立旧路径标签", async () => {
  const path = "/work/assets/blob.unknownext";
  const id = filesFileBufferId(workspace, path);
  const store = createFilesEditorStore();
  store.getState().hydrateSession(
    sessionWithTabs({
      activeId: id,
      tabs: [{ id, kind: "text", path, workspace }],
    }),
  );
  let resolveRead!: (value: FileTextWindow) => void;
  const loader = captureRestore(
    store,
    servicesWith(
      () =>
        new Promise<FileTextWindow>((resolve) => {
          resolveRead = resolve;
        }),
    ),
  );

  const loading = loader.loadRestoredTextFile(id);
  await Promise.resolve();
  store.getState().applyFileMutation({ workspace, kind: "delete", path });
  resolveRead(textWindow(path, "\u0000binary", true));
  await loading;

  const state = store.getState();
  assert.equal(
    state.buffers.some((buffer) => buffer.id === id),
    false,
  );
  assert.equal(
    state.buffers.some((buffer) => buffer.path === path),
    false,
  );
  assert.deepEqual(state.openIds, []);
});

test("读取在途时编辑的文本草稿不会被迟到的文本结果覆盖", async () => {
  const path = "/work/src/app.ts";
  const id = filesFileBufferId(workspace, path);
  const store = createFilesEditorStore();
  store.getState().hydrateSession(
    sessionWithTabs({
      activeId: id,
      tabs: [{ id, kind: "text", path, workspace }],
    }),
  );
  let resolveRead!: (value: FileTextWindow) => void;
  let reads = 0;
  const loader = captureRestore(
    store,
    servicesWith(() => {
      reads += 1;
      return new Promise<FileTextWindow>((resolve) => {
        resolveRead = resolve;
      });
    }),
  );

  const loading = loader.loadRestoredTextFile(id);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(reads, 1);
  store.getState().updateText(id, "typed while loading");
  resolveRead(textWindow(path, "disk text", false));
  await loading;

  const buffer = store.getState().buffers[0]!;
  assert.equal(buffer.kind, "text");
  assert.ok(buffer.kind === "text");
  assert.equal(buffer.text, "typed while loading");
  assert.equal(buffer.savedText, "");
  assert.equal(isFilesBufferDirty(buffer), true);
  // 迟到的读取必须放弃本次提交并清掉 loading，否则界面会一直停在加载态。
  assert.equal(buffer.loadState, undefined);
  assert.equal(reads, 1);
});

test("读取在途时编辑的文本草稿不会被迟到的二进制结果转成预览", async () => {
  const path = "/work/assets/blob.unknownext";
  const id = filesFileBufferId(workspace, path);
  const store = createFilesEditorStore();
  store.getState().hydrateSession(
    sessionWithTabs({
      activeId: id,
      tabs: [{ id, kind: "text", path, workspace, preview: true }],
    }),
  );
  let resolveRead!: (value: FileTextWindow) => void;
  let reads = 0;
  const loader = captureRestore(
    store,
    servicesWith(() => {
      reads += 1;
      return new Promise<FileTextWindow>((resolve) => {
        resolveRead = resolve;
      });
    }),
  );

  const loading = loader.loadRestoredTextFile(id);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(reads, 1);
  store.getState().updateText(id, "typed while loading");
  resolveRead(textWindow(path, "\u0000binary", true));
  await loading;

  const buffer = store.getState().buffers[0]!;
  assert.equal(buffer.kind, "text");
  assert.ok(buffer.kind === "text");
  assert.equal(buffer.text, "typed while loading");
  assert.equal(buffer.savedText, "");
  assert.equal(isFilesBufferDirty(buffer), true);
  assert.equal(buffer.loadState, undefined);
  assert.equal(reads, 1);
});

test("target 提交按 filesWorkspaceKey 拒绝不同工作区的同路径缓冲", () => {
  const path = "/work/shared/file.ts";
  const id = filesFileBufferId(workspace, path);
  const otherWorkspace: FilesWorkspaceRef = {
    ...workspace,
    workspaceIdentity: "ssh://other-host/work",
  };
  const store = createFilesEditorStore();
  store.getState().openBuffer({
    ...createTextFileBuffer({ workspace, path, text: "" }),
    loadState: "loading",
  });

  const committed = commitFilesEditorTextReadResult({
    store,
    workspace: otherWorkspace,
    path,
    result: readResult(path, "other workspace text", false),
    targetId: id,
  });

  assert.equal(committed, null);
  const buffer = store.getState().buffers[0]!;
  assert.equal(buffer.kind, "text");
  assert.ok(buffer.kind === "text");
  assert.equal(buffer.text, "");
  assert.equal(buffer.savedText, "");
  assert.equal(buffer.loadState, "loading");
});

test("提交读取结果保留 workspaceIdentity 与 remoteSessionId，同名路径按身份隔离", () => {
  const remoteWorkspace: FilesWorkspaceRef = {
    workspacePath: "/work",
    workspaceIdentity: "ssh://build-host/work",
    workspaceRemoteSessionId: "remote-1",
  };
  const path = "/work/shared/file.unknownext";
  const store = createFilesEditorStore();

  commitFilesEditorTextReadResult({
    store,
    workspace: remoteWorkspace,
    path,
    result: readResult(path, "\u0000remote", true),
  });
  commitFilesEditorTextReadResult({
    store,
    workspace,
    path,
    result: readResult(path, "local text", false),
  });

  const remoteId = filesFileBufferId(remoteWorkspace, path);
  const localId = filesFileBufferId(workspace, path);
  assert.notEqual(remoteId, localId);
  const byId = new Map(store.getState().buffers.map((buffer) => [buffer.id, buffer]));
  const remoteBuffer = byId.get(remoteId)!;
  const localBuffer = byId.get(localId)!;
  assert.equal(remoteBuffer.kind, "preview");
  assert.equal(remoteBuffer.workspace.workspaceIdentity, remoteWorkspace.workspaceIdentity);
  assert.equal(
    remoteBuffer.workspace.workspaceRemoteSessionId,
    remoteWorkspace.workspaceRemoteSessionId,
  );
  assert.equal(localBuffer.kind, "text");
  assert.ok(localBuffer.kind === "text");
  assert.equal(localBuffer.text, "local text");
});
