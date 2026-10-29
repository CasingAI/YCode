import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FILE_TEXT_WINDOW_CHANGED_CODE,
  FILE_TEXT_WINDOW_MAX_BYTES,
  type FileTextWindow,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { TabStoreProvider } from "../src/store/TabStoreProvider.js";
import {
  FilesEditorStoreProvider,
  useFilesEditorStoreApi,
} from "../src/files-workbench/FilesEditorStoreProvider.js";
import { useFilesWorkbenchController } from "../src/files-workbench/useFilesWorkbenchController.js";
import { useFilesEditorRestore } from "../src/files-workbench/useFilesEditorRestore.js";
import {
  canSaveFilesBuffer,
  createLargeTextFileBuffer,
  createTextFileBuffer,
  filesFileBufferId,
  isFilesBufferDirty,
} from "../src/files-workbench/filesEditorModel.js";
import { createFilesEditorStore } from "../src/files-workbench/filesEditorStore.js";
import type { FilesEditorStore } from "../src/files-workbench/filesEditorStore.js";
import { saveFilesTextBuffer } from "../src/files-workbench/filesEditorSaveIO.js";
import {
  FILES_EDITABLE_TEXT_MAX_BYTES,
  FilesTextReadChangedError,
  isFilesTextReadMissingError,
  readFilesTextForOpen,
  readFilesTextForSave,
  resolveFilesTextReadMode,
} from "../src/files-workbench/filesEditorTextReader.js";
import { readFilesEditorSession } from "../src/files-workbench/filesEditorPersistence.js";
import { acquireFilesLargeTextWindow } from "../src/files-workbench/filesLargeTextWindowStore.js";
import { filesLargeTextWindowOwner } from "../src/files-workbench/filesLargeTextWindowSeed.js";
import type {
  FilesBuffer,
  FilesPersistedSession,
  FilesWorkspaceRef,
} from "../src/files-workbench/filesEditorTypes.js";

const workspace: FilesWorkspaceRef = { workspacePath: "/work" };

interface ReadRequest {
  path: string;
  offset?: number;
  length?: number;
  expectedVersion?: string;
}

/**
 * 用真实 UTF-8 字节模拟文件服务的窗口语义：单窗 <= 256KiB、nextOffset 连续、
 * 后续窗口可带 expectedVersion。测试不能让 UI 退回旧的 readTextFile。
 */
function createWindowReader(
  content: string,
  options?: {
    totalBytes?: number;
    isBinary?: boolean;
    version?: string;
    hasDecodingErrors?: (offset: number) => boolean;
  },
) {
  const bytes = Buffer.from(content, "utf8");
  const totalBytes = options?.totalBytes ?? bytes.length;
  const version = options?.version ?? "v1";
  const calls: ReadRequest[] = [];
  const reader = {
    calls,
    async readTextFileWindow(request: ReadRequest): Promise<FileTextWindow> {
      calls.push(request);
      if (request.expectedVersion !== undefined && request.expectedVersion !== version) {
        throw Object.assign(new Error("changed"), { code: FILE_TEXT_WINDOW_CHANGED_CODE });
      }
      const offset = Math.max(0, Math.min(request.offset ?? 0, totalBytes));
      const maxReadable = Math.min(totalBytes, bytes.length);
      const start = Math.min(offset, maxReadable);
      const length = Math.min(
        request.length ?? FILE_TEXT_WINDOW_MAX_BYTES,
        FILE_TEXT_WINDOW_MAX_BYTES,
      );
      const end = Math.min(start + length, maxReadable);
      const isBinary = options?.isBinary === true;
      return {
        path: request.path,
        content: isBinary ? "" : bytes.subarray(start, end).toString("utf8"),
        offset: start,
        bytesRead: end - start,
        nextOffset: end,
        totalBytes,
        version,
        isBinary,
        hasDecodingErrors: !isBinary && options?.hasDecodingErrors?.(start) === true,
        eof: end >= totalBytes,
        truncated: end < totalBytes,
      };
    },
  };
  return reader;
}

function servicesWith(fileService: unknown): IServiceAccessor {
  return { fileService } as unknown as IServiceAccessor;
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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

function captureRestore(store: FilesEditorStore, services: IServiceAccessor) {
  let loader!: ReturnType<typeof useFilesEditorRestore>;
  function Capture() {
    loader = useFilesEditorRestore({
      store,
      restoreEnabled: false,
      persist: () => undefined,
      resolveServices: () => services,
    });
    return null;
  }
  renderToStaticMarkup(createElement(Capture));
  return loader;
}

function sessionWithLargeTab(id: string, path: string): FilesPersistedSession {
  return {
    version: 1,
    activeId: id,
    openFileIds: [id],
    openTabs: [{ id, kind: "large-text", path, workspace }],
    drafts: [],
  };
}

test("读取决策只在 8 MiB 阈值处切换可编辑与只读大文本", () => {
  assert.equal(
    resolveFilesTextReadMode({ isBinary: false, totalBytes: FILES_EDITABLE_TEXT_MAX_BYTES }),
    "editable",
  );
  assert.equal(
    resolveFilesTextReadMode({ isBinary: false, totalBytes: FILES_EDITABLE_TEXT_MAX_BYTES + 1 }),
    "large-text",
  );
  assert.equal(resolveFilesTextReadMode({ isBinary: true, totalBytes: 10 }), "binary");
});

test("≤ 8 MiB 文本按窗口完整读取，后续窗口都带首窗版本且不丢不重", async () => {
  const text = "A".repeat(600 * 1024);
  const reader = createWindowReader(text);

  const result = await readFilesTextForOpen(reader, "/work/big.txt");

  assert.equal(result.mode, "editable");
  assert.equal(result.mode === "editable" ? result.text.length : 0, text.length);
  assert.equal(result.mode === "editable" ? result.text : "", text);
  assert.equal(reader.calls.length, 3);
  assert.equal(reader.calls[0]?.offset, 0);
  for (const call of reader.calls) {
    assert.ok((call.length ?? 0) <= FILE_TEXT_WINDOW_MAX_BYTES);
  }
  assert.equal(reader.calls[1]?.expectedVersion, "v1");
  assert.equal(reader.calls[2]?.expectedVersion, "v1");
});

test("> 8 MiB 文本只读首窗即判定，不继续扫描全文", async () => {
  const reader = createWindowReader("head", { totalBytes: FILES_EDITABLE_TEXT_MAX_BYTES + 1 });

  const result = await readFilesTextForOpen(reader, "/work/huge.txt");

  assert.equal(result.mode, "large-text");
  assert.equal(result.totalBytes, FILES_EDITABLE_TEXT_MAX_BYTES + 1);
  assert.equal(reader.calls.length, 1);
});

test("首窗存在解码错误时即使 ≤ 8 MiB 也只读首窗，不返回可编辑", async () => {
  const reader = createWindowReader("bad bytes", { hasDecodingErrors: () => true });

  const result = await readFilesTextForOpen(reader, "/work/lossy.txt");

  assert.equal(result.mode, "large-text");
  assert.equal(result.mode === "large-text" ? result.reason : undefined, "encoding");
  assert.equal(result.mode === "large-text" ? result.firstWindow.content : "", "bad bytes");
  assert.equal("text" in result, false);
  assert.equal(reader.calls.length, 1);
  assert.equal(
    resolveFilesTextReadMode({ isBinary: false, totalBytes: 3, hasDecodingErrors: true }),
    "large-text",
  );
});

test("后续窗口存在解码错误时整份转只读，保留首窗前缀且不缓存失败窗口", async () => {
  const text = "A".repeat(FILE_TEXT_WINDOW_MAX_BYTES + 10);
  const reader = createWindowReader(text, {
    hasDecodingErrors: (offset) => offset > 0,
  });

  const result = await readFilesTextForOpen(reader, "/work/lossy-later.txt");

  assert.equal(result.mode, "large-text");
  assert.ok(result.mode === "large-text");
  assert.equal(result.reason, "encoding");
  assert.equal(result.firstWindow.offset, 0);
  assert.equal(result.firstWindow.content, "A".repeat(FILE_TEXT_WINDOW_MAX_BYTES));
  assert.equal(result.totalBytes, Buffer.byteLength(text));
  assert.equal("text" in result, false);
  // 读到第二个（含非法字节）窗口后停止，不再继续拼接。
  assert.equal(reader.calls.length, 2);
});

test("稀疏 > 1 GiB 文件只做一次有界决策读取", async () => {
  const reader = createWindowReader("", { totalBytes: 2 * 1024 * 1024 * 1024 });

  const result = await readFilesTextForOpen(reader, "/work/sparse.log");

  assert.equal(result.mode, "large-text");
  assert.equal(reader.calls.length, 1);
  assert.equal(reader.calls[0]?.length, FILE_TEXT_WINDOW_MAX_BYTES);
});

test("首窗为二进制时优先预览，不建立文本或大文本缓冲", async () => {
  const reader = createWindowReader("\u0000binary", { isBinary: true });

  const result = await readFilesTextForOpen(reader, "/work/blob.unknown");

  assert.equal(result.mode, "binary");
  assert.equal(reader.calls.length, 1);
});

test("完整读取中途版本变化时整次失败，不提交拼接正文", async () => {
  const text = "B".repeat(FILE_TEXT_WINDOW_MAX_BYTES + 10);
  const reader = createWindowReader(text);
  const original = reader.readTextFileWindow.bind(reader);
  let calls = 0;
  reader.readTextFileWindow = async (request) => {
    calls += 1;
    if (calls === 2) {
      throw Object.assign(new Error("changed"), { code: FILE_TEXT_WINDOW_CHANGED_CODE });
    }
    return original(request);
  };

  await assert.rejects(() => readFilesTextForOpen(reader, "/work/changing.txt"));
});

test("保存前完整读取超过 256KiB 的磁盘正文，而不是把首窗当完整内容", async () => {
  const diskText = "D".repeat(600 * 1024);
  const reader = createWindowReader(diskText);

  const result = await readFilesTextForSave(reader, "/work/big.txt");

  assert.equal(result.mode, "editable");
  assert.equal(result.mode === "editable" ? result.text : "", diskText);
  assert.equal(reader.calls.length, 3);
});

test("保存前发现磁盘 > 8 MiB 时立即停止，不继续读大文件", async () => {
  const reader = createWindowReader("head", { totalBytes: FILES_EDITABLE_TEXT_MAX_BYTES + 1 });

  const result = await readFilesTextForSave(reader, "/work/huge.txt");

  assert.equal(result.mode, "large-text");
  assert.equal(reader.calls.length, 1);
});

test("打开 > 8 MiB 文本建立可编辑 large-text 缓冲，不写 text/savedText 并保存首窗版本", async () => {
  const path = "/work/huge.log";
  const reader = createWindowReader("head", { totalBytes: FILES_EDITABLE_TEXT_MAX_BYTES + 1 });
  const { controller, store } = renderController(servicesWith(reader));

  await controller.openExistingPath(workspace, path);

  const state = store.getState();
  const id = filesFileBufferId(workspace, path);
  const buffer = state.buffers.find((candidate) => candidate.id === id)!;
  assert.equal(buffer.kind, "large-text");
  assert.ok(buffer.kind === "large-text");
  assert.equal(buffer.path, path);
  assert.equal(buffer.workspace, workspace);
  assert.equal(buffer.totalBytes, FILES_EDITABLE_TEXT_MAX_BYTES + 1);
  assert.equal("text" in buffer, false);
  assert.equal("savedText" in buffer, false);
  assert.equal(buffer.edit?.baseVersion, "v1");
  assert.equal(buffer.edit?.baseTotalBytes, FILES_EDITABLE_TEXT_MAX_BYTES + 1);
  assert.equal(canSaveFilesBuffer(buffer), true);
  assert.equal(isFilesBufferDirty(buffer), false);
  assert.deepEqual(state.openIds, [id]);
  // core 决策的首窗已 prime；viewer 挂载后 ensureLoaded 不得再读首窗。
  assert.equal(reader.calls.length, 1);
  let viewerReads = 0;
  const lease = acquireFilesLargeTextWindow({
    owner: filesLargeTextWindowOwner(buffer),
    initialTotalBytes: buffer.totalBytes,
    readWindow: async () => {
      viewerReads += 1;
      throw new Error("seeded window should not be reread");
    },
  });
  lease.ensureLoaded();
  assert.equal(viewerReads, 0);
  assert.equal(lease.getSnapshot().window?.content, "head");
  lease.release();
  // 任意块修改都直接成为可提交草稿。
  store
    .getState()
    .updateLargeTextBlock(
      id,
      { blockIndex: 0, offset: 0, deleteBytes: 4, originalText: "head" },
      "head edited",
    );
  const edited = store.getState().buffers.find((candidate) => candidate.id === id)!;
  assert.equal(canSaveFilesBuffer(edited), true);
  assert.equal(isFilesBufferDirty(edited), true);
  // 持久化只保留 path / kind / workspace，不落窗口正文或偏移。
  const tab = state.snapshotSession().openTabs[0]!;
  assert.equal(tab.kind, "large-text");
  assert.equal(tab.path, path);
  assert.equal("text" in tab, false);
});

test("打开 ≤ 8 MiB 但含解码错误的文本建立 encoding 只读缓冲并 seed 首窗", async () => {
  const path = "/work/lossy-small.txt";
  const reader = createWindowReader("A".repeat(600 * 1024), {
    hasDecodingErrors: () => true,
  });
  const { controller, store } = renderController(servicesWith(reader));

  await controller.openExistingPath(workspace, path);

  const buffer = store.getState().buffers[0]!;
  assert.ok(buffer.kind === "large-text");
  assert.equal(buffer.totalBytes, 600 * 1024);
  assert.equal(buffer.readonlyReason, "encoding");
  assert.equal(canSaveFilesBuffer(buffer), true);
  // 首窗决策已命中非法字节，不能继续扫描可编辑全文。
  assert.equal(reader.calls.length, 1);
  const lease = acquireFilesLargeTextWindow({
    owner: filesLargeTextWindowOwner(buffer),
    readWindow: async () => {
      throw new Error("seeded window should not be reread");
    },
  });
  assert.equal(lease.getSnapshot().window?.content, "A".repeat(FILE_TEXT_WINDOW_MAX_BYTES));
  lease.release();
});

test("≤ 8 MiB 多窗口文本完整合并后才建立可编辑缓冲", async () => {
  const path = "/work/editable.txt";
  const text = "E".repeat(600 * 1024);
  const reader = createWindowReader(text);
  const { controller, store } = renderController(servicesWith(reader));

  await controller.openExistingPath(workspace, path);

  const buffer = store.getState().buffers[0]!;
  assert.ok(buffer.kind === "text");
  assert.equal(buffer.text.length, text.length);
  assert.equal(buffer.text, text);
  assert.equal(buffer.savedText, text);
  assert.equal(buffer.truncated, undefined);
  assert.equal(canSaveFilesBuffer(buffer), true);
  assert.equal(reader.calls.length, 3);
});

test("大文本没有块修改时不允许保存，也不触碰 commitTextFile", async () => {
  const commits: unknown[] = [];
  const reader = createWindowReader("head", { totalBytes: FILES_EDITABLE_TEXT_MAX_BYTES + 1 });
  const { controller, store } = renderController(
    servicesWith({
      ...reader,
      commitTextFile: async (params: unknown) => {
        commits.push(params);
        return { path: "/work/huge.log", version: "v2", totalBytes: 1 };
      },
    }),
  );
  const large = createLargeTextFileBuffer({
    workspace,
    path: "/work/huge.log",
    totalBytes: FILES_EDITABLE_TEXT_MAX_BYTES + 1,
  });
  store.getState().openBuffer(large);

  const saved = await controller.saveTextBuffer(large);

  assert.equal(saved, false);
  assert.deepEqual(commits, []);
  assert.equal(reader.calls.length, 0);
});

test("旧截断文本即使被直接调用保存也被底层 guard 阻止", async () => {
  const commits: unknown[] = [];
  const reader = createWindowReader("full disk text");
  const { controller, store } = renderController(
    servicesWith({
      ...reader,
      commitTextFile: async (params: unknown) => {
        commits.push(params);
        return { path: "/work/legacy.txt", version: "v2", totalBytes: 1 };
      },
    }),
  );
  const path = "/work/legacy.txt";
  const truncated = {
    ...createTextFileBuffer({ workspace, path, text: "partial" }),
    truncated: true,
  };
  store.getState().openBuffer(truncated);

  const saved = await controller.saveTextBuffer(truncated);

  assert.equal(saved, false);
  assert.deepEqual(commits, []);
  assert.equal(reader.calls.length, 0);
});

test("旧草稿保存先完整读取磁盘；磁盘跨过阈值时进入冲突且不提交", async () => {
  const path = "/work/current.txt";
  const commits: unknown[] = [];
  const reader = createWindowReader("disk", {
    totalBytes: FILES_EDITABLE_TEXT_MAX_BYTES + 1,
  });
  const { controller, store } = renderController(
    servicesWith({
      ...reader,
      commitTextFile: async (params: unknown) => {
        commits.push(params);
        return { path, version: "v2", totalBytes: 1 };
      },
    }),
  );
  const buffer = {
    ...createTextFileBuffer({ workspace, path, text: "editor text" }),
    savedText: "disk",
  };
  store.getState().openBuffer(buffer);

  const saved = await controller.saveTextBuffer(buffer);

  assert.equal(saved, false);
  assert.deepEqual(commits, []);
  assert.equal(reader.calls.length, 1);
  const current = store.getState().buffers[0]!;
  assert.ok(current.kind === "text");
  assert.equal(current.text, "editor text");
  assert.equal(isFilesBufferDirty(current), true);
});

test("旧草稿版本未知时即使 force 也不按探测到的版本盲写", async () => {
  const path = "/work/current.txt";
  const commits: { expectedVersion: string | null; write: { kind: string; text?: string } }[] = [];
  const reader = createWindowReader("disk", {
    totalBytes: FILES_EDITABLE_TEXT_MAX_BYTES + 1,
  });
  const { controller, store } = renderController(
    servicesWith({
      ...reader,
      commitTextFile: async (params: {
        expectedVersion: string | null;
        write: { kind: string; text?: string };
      }) => {
        commits.push(params);
        return { path, version: "v2", totalBytes: 21 };
      },
    }),
  );
  const buffer = {
    ...createTextFileBuffer({ workspace, path, text: "complete editor text" }),
    savedText: "disk",
  };
  store.getState().openBuffer(buffer);

  const saved = await controller.saveTextBuffer(buffer, { force: true });

  assert.equal(saved, false);
  assert.equal(commits.length, 0);
  assert.equal(reader.calls.length, 0);
  const current = store.getState().buffers[0]!;
  assert.ok(current.kind === "text");
  assert.equal(isFilesBufferDirty(current), true);
});

test("旧草稿读取发现解码错误时按冲突处理，force 仍拒绝未知版本", async () => {
  const path = "/work/lossy-save.txt";
  const commits: unknown[] = [];
  const reader = createWindowReader("disk", { hasDecodingErrors: () => true });
  const { controller, store } = renderController(
    servicesWith({
      ...reader,
      commitTextFile: async (params: unknown) => {
        commits.push(params);
        return { path, version: "v2", totalBytes: 11 };
      },
    }),
  );
  const buffer = {
    ...createTextFileBuffer({ workspace, path, text: "editor text" }),
    savedText: "disk",
  };
  store.getState().openBuffer(buffer);

  assert.equal(await controller.saveTextBuffer(buffer), false);
  assert.deepEqual(commits, []);
  assert.equal(reader.calls.length, 1);

  // 解码不完整时无法产生可确认版本；force 重新提示但不得提交。
  assert.equal(await controller.saveTextBuffer(buffer, { force: true }), false);
  assert.deepEqual(commits, []);
  assert.equal(reader.calls.length, 1);
  const current = store.getState().buffers[0]!;
  assert.ok(current.kind === "text");
  assert.equal(isFilesBufferDirty(current), true);
});

test("旧草稿保存前完整读取 > 256KiB 磁盘文本后提交整份缓冲", async () => {
  const path = "/work/big.txt";
  const diskText = "D".repeat(600 * 1024);
  const commits: { write: { kind: string; text?: string } }[] = [];
  const reader = createWindowReader(diskText);
  const { controller, store } = renderController(
    servicesWith({
      ...reader,
      commitTextFile: async (params: { write: { kind: string; text?: string } }) => {
        commits.push(params);
        return { path, version: "v2", totalBytes: diskText.length + 1 };
      },
    }),
  );
  const buffer = {
    ...createTextFileBuffer({ workspace, path, text: `${diskText}!` }),
    savedText: diskText,
  };
  store.getState().openBuffer(buffer);

  const saved = await controller.saveTextBuffer(buffer);

  assert.equal(saved, true);
  assert.equal(commits.length, 1);
  assert.equal(commits[0]?.write.kind, "full");
  assert.equal(commits[0]?.write.text?.length, diskText.length + 1);
  assert.equal(reader.calls.length, 3);
});

test("已存文件缺失按删除冲突处理，不静默重建", async () => {
  const path = "/work/new.txt";
  const commits: unknown[] = [];
  const { controller, store } = renderController(
    servicesWith({
      readTextFileWindow: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      commitTextFile: async (params: unknown) => {
        commits.push(params);
        return { path, version: "v2", totalBytes: 11 };
      },
    }),
  );
  const buffer = createTextFileBuffer({ workspace, path, text: "new content" });
  store.getState().openBuffer(buffer);

  const saved = await controller.saveTextBuffer(buffer);

  assert.equal(saved, false);
  assert.deepEqual(commits, []);
});

test("后续窗口 ENOENT 统一转为 CHANGED，只有首窗缺失才按新建处理", async () => {
  const path = "/work/vanishing-window.txt";
  const text = "V".repeat(FILE_TEXT_WINDOW_MAX_BYTES + 10);
  const reader = createWindowReader(text);
  const original = reader.readTextFileWindow.bind(reader);
  let calls = 0;
  reader.readTextFileWindow = async (request) => {
    calls += 1;
    if (calls === 2) {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    return original(request);
  };
  const isChanged = (error: unknown) =>
    error instanceof FilesTextReadChangedError &&
    (error as { code?: string }).code === FILE_TEXT_WINDOW_CHANGED_CODE;

  await assert.rejects(() => readFilesTextForOpen(reader, path), isChanged);
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(() => readFilesTextForSave(reader, path), isChanged);
  assert.equal(calls, 2);
});

test("完整读取后续窗口 ENOENT 时保存失败且不写盘，force 也不跳过读取失败", async () => {
  const path = "/work/vanishing-save.txt";
  const diskText = "D".repeat(FILE_TEXT_WINDOW_MAX_BYTES + 10);
  const writes: string[] = [];
  const failed: string[] = [];
  const reader = createWindowReader(diskText);
  const original = reader.readTextFileWindow.bind(reader);
  reader.readTextFileWindow = async (request) => {
    // 首窗照常返回；后续窗口按「读盘期间文件消失」处理。
    if ((request.offset ?? 0) > 0) {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    return original(request);
  };
  const store = createFilesEditorStore();
  const buffer = {
    ...createTextFileBuffer({ workspace, path, text: "editor text" }),
    savedText: "disk text",
  };
  store.getState().openBuffer(buffer);
  const save = (force?: boolean) =>
    saveFilesTextBuffer({
      store,
      buffer,
      path,
      force,
      fileService: {
        readTextFileWindow: reader.readTextFileWindow,
        writeTextFile: async ({ content }: { content: string }) => {
          writes.push(content);
        },
      },
      onConflict: () => assert.fail("后续窗口缺失不应进入冲突或覆盖流程"),
      onSaveFailed: (failedPath) => failed.push(failedPath),
      onBusy: () => undefined,
      onSaved: () => undefined,
    });

  assert.equal(await save(), false);
  assert.deepEqual(writes, []);
  assert.deepEqual(failed, [path]);
  let current = store.getState().buffers[0]!;
  assert.ok(current.kind === "text");
  assert.equal(isFilesBufferDirty(current), true);

  // force 只跳过冲突确认，不能把读取失败当作可覆盖。
  assert.equal(await save(true), false);
  assert.deepEqual(writes, []);
  assert.deepEqual(failed, [path, path]);
  current = store.getState().buffers[0]!;
  assert.ok(current.kind === "text");
  assert.equal(isFilesBufferDirty(current), true);
});

test("保存前 ENOTDIR 属于父路径错误，不按文件不存在覆盖", async () => {
  const path = "/work/not-a-directory/file.txt";
  const writes: string[] = [];
  const failed: string[] = [];
  const store = createFilesEditorStore();
  const buffer = {
    ...createTextFileBuffer({ workspace, path, text: "editor text" }),
    savedText: "disk text",
  };
  store.getState().openBuffer(buffer);

  assert.equal(isFilesTextReadMissingError({ code: "ENOTDIR" }), false);
  const saved = await saveFilesTextBuffer({
    store,
    buffer,
    path,
    fileService: {
      readTextFileWindow: async () => {
        throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
      },
      writeTextFile: async ({ content }: { content: string }) => {
        writes.push(content);
      },
    },
    onConflict: () => assert.fail("ENOTDIR 不应进入冲突"),
    onSaveFailed: (failedPath) => failed.push(failedPath),
    onBusy: () => undefined,
    onSaved: () => undefined,
  });

  assert.equal(saved, false);
  assert.deepEqual(writes, []);
  assert.deepEqual(failed, [path]);
  const current = store.getState().buffers[0]!;
  assert.ok(current.kind === "text");
  assert.equal(current.text, "editor text");
  assert.equal(isFilesBufferDirty(current), true);
});

test("保存 await 读盘期间路径改名后放弃提交，不把旧正文写回", async () => {
  const path = "/work/rename-during-save.txt";
  const commits: unknown[] = [];
  let finishRead!: (value: FileTextWindow) => void;
  let started = false;
  const { controller, store } = renderController(
    servicesWith({
      readTextFileWindow: () => {
        started = true;
        return new Promise<FileTextWindow>((resolve) => {
          finishRead = resolve;
        });
      },
      commitTextFile: async (params: unknown) => {
        commits.push(params);
        return { path, version: "v2", totalBytes: 4 };
      },
    }),
  );
  const buffer = createTextFileBuffer({ workspace, path, text: "editor text" });
  store.getState().openBuffer(buffer);

  const saving = controller.saveTextBuffer(buffer);
  await flushAsync();
  assert.equal(started, true);
  store.getState().applyFileMutation({
    workspace,
    kind: "rename",
    path,
    newPath: "/work/renamed-during-save.txt",
  });
  finishRead({
    path,
    content: "disk",
    offset: 0,
    bytesRead: 4,
    nextOffset: 4,
    totalBytes: 4,
    version: "v1",
    isBinary: false,
    eof: true,
    truncated: false,
  });

  assert.equal(await saving, false);
  assert.deepEqual(commits, []);
});

test("保存 await 读盘期间缓冲不再可保存时放弃提交", async () => {
  const path = "/work/truncated-during-save.txt";
  const commits: unknown[] = [];
  let finishRead!: (value: FileTextWindow) => void;
  const { controller, store } = renderController(
    servicesWith({
      readTextFileWindow: () =>
        new Promise<FileTextWindow>((resolve) => {
          finishRead = resolve;
        }),
      commitTextFile: async (params: unknown) => {
        commits.push(params);
        return { path, version: "v2", totalBytes: 4 };
      },
    }),
  );
  const buffer = createTextFileBuffer({ workspace, path, text: "editor text" });
  store.getState().openBuffer(buffer);

  const saving = controller.saveTextBuffer(buffer);
  await flushAsync();
  store.getState().setTextLoadState(buffer.id, "loading");
  finishRead({
    path,
    content: "disk",
    offset: 0,
    bytesRead: 4,
    nextOffset: 4,
    totalBytes: 4,
    version: "v1",
    isBinary: false,
    eof: true,
    truncated: false,
  });

  assert.equal(await saving, false);
  assert.deepEqual(commits, []);
});

test("恢复干净文本标签时磁盘已变大超过阈值，在原 ID 内转为只读大文本", async () => {
  const path = "/work/grown.txt";
  const id = filesFileBufferId(workspace, path);
  const store = createFilesEditorStore();
  store.getState().hydrateSession({
    version: 1,
    activeId: id,
    openFileIds: [id],
    openTabs: [{ id, kind: "text", path, workspace }],
    drafts: [],
  });
  const reader = createWindowReader("head", {
    totalBytes: FILES_EDITABLE_TEXT_MAX_BYTES + 1,
  });
  const loader = captureRestore(store, servicesWith(reader));

  await loader.loadRestoredTextFile(id);

  const buffer = store.getState().buffers[0]!;
  assert.equal(buffer.kind, "large-text");
  assert.equal(buffer.id, id);
  assert.equal(canSaveFilesBuffer(buffer), true);
  assert.equal(reader.calls.length, 1);
});

test("恢复 large-text 标签时不读盘，激活后按同一决策转回可编辑文本", async () => {
  const path = "/work/restored.txt";
  const id = filesFileBufferId(workspace, path);
  const store = createFilesEditorStore();
  store.getState().hydrateSession(sessionWithLargeTab(id, path));

  const restored = store.getState().buffers[0]!;
  assert.equal(restored.kind, "large-text");

  const reader = createWindowReader("small again");
  const loader = captureRestore(store, servicesWith(reader));
  await loader.loadRestoredTextFile(id);

  const buffer = store.getState().buffers[0]!;
  assert.ok(buffer.kind === "text");
  assert.equal(buffer.text, "small again");
  assert.equal(buffer.savedText, "small again");
  assert.equal(canSaveFilesBuffer(buffer), true);
  assert.equal(reader.calls.length, 1);
});

test("恢复 large-text 标签时磁盘仍大则保持只读，且本次会话不重复决策", async () => {
  const path = "/work/restored-huge.log";
  const id = filesFileBufferId(workspace, path);
  const store = createFilesEditorStore();
  store.getState().hydrateSession(sessionWithLargeTab(id, path));
  const reader = createWindowReader("head", {
    totalBytes: FILES_EDITABLE_TEXT_MAX_BYTES + 10,
  });
  const loader = captureRestore(store, servicesWith(reader));

  await loader.loadRestoredTextFile(id);
  await loader.loadRestoredTextFile(id);

  const buffer = store.getState().buffers[0]!;
  assert.equal(buffer.kind, "large-text");
  assert.ok(buffer.kind === "large-text");
  // 决策后补全 totalBytes 并 prime 首窗；后续激活不再重复恢复读取。
  assert.equal(buffer.totalBytes, FILES_EDITABLE_TEXT_MAX_BYTES + 10);
  assert.equal(canSaveFilesBuffer(buffer), true);
  assert.equal(reader.calls.length, 1);
  let viewerReads = 0;
  const lease = acquireFilesLargeTextWindow({
    owner: filesLargeTextWindowOwner(buffer),
    initialTotalBytes: buffer.totalBytes,
    readWindow: async () => {
      viewerReads += 1;
      throw new Error("seeded window should not be reread");
    },
  });
  lease.ensureLoaded();
  assert.equal(viewerReads, 0);
  assert.equal(lease.getSnapshot().window?.content, "head");
  lease.release();
});

test("恢复 large 决策失败时 rangeStore 显示错误，retry 重新走统一决策", async () => {
  const path = "/work/restored-offline.log";
  const id = filesFileBufferId(workspace, path);
  const store = createFilesEditorStore();
  store.getState().hydrateSession(sessionWithLargeTab(id, path));
  const restored = store.getState().buffers[0]!;
  assert.ok(restored.kind === "large-text");
  assert.equal(restored.totalBytes, undefined);

  let fail = true;
  let reads = 0;
  const reader = createWindowReader("head", {
    totalBytes: FILES_EDITABLE_TEXT_MAX_BYTES + 10,
  });
  const readWindow = reader.readTextFileWindow.bind(reader);
  reader.readTextFileWindow = async (request) => {
    reads += 1;
    if (fail) {
      throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    }
    return readWindow(request);
  };
  const loader = captureRestore(store, servicesWith(reader));
  let directReads = 0;
  const lease = acquireFilesLargeTextWindow({
    owner: filesLargeTextWindowOwner(restored),
    readWindow: async () => {
      directReads += 1;
      throw new Error("viewer must not bypass core decision");
    },
  });

  await loader.loadRestoredTextFile(id);
  const failed = lease.getSnapshot();
  assert.equal(failed.phase, "error");
  assert.equal(failed.error?.kind, "offline");
  assert.equal(failed.window, null);
  assert.equal(reads, 1);

  fail = false;
  lease.retry();
  await flushAsync();
  await flushAsync();

  // 重试必须经过 core loader，而不是 viewer 自己按窗口读取。
  assert.equal(reads, 2);
  assert.equal(directReads, 0);
  const ready = lease.getSnapshot();
  assert.equal(ready.phase, "ready");
  assert.equal(ready.window?.content, "head");
  assert.equal(ready.error, null);
  const buffer = store.getState().buffers[0]!;
  assert.ok(buffer.kind === "large-text");
  assert.equal(buffer.totalBytes, FILES_EDITABLE_TEXT_MAX_BYTES + 10);
  lease.release();
});

test("seed 后关闭、转为文本或改名都会清理 rangeStore owner entry", async () => {
  const openLarge = async (path: string) => {
    const reader = createWindowReader("head", {
      totalBytes: FILES_EDITABLE_TEXT_MAX_BYTES + 1,
    });
    const rendered = renderController(servicesWith(reader));
    await rendered.controller.openExistingPath(workspace, path);
    const buffer = rendered.store.getState().buffers[0]!;
    assert.ok(buffer.kind === "large-text");
    return { ...rendered, buffer };
  };

  const closed = await openLarge("/work/seed-close.log");
  closed.store.getState().closeBuffer(closed.buffer.id);
  const afterClose = acquireFilesLargeTextWindow({
    owner: filesLargeTextWindowOwner(closed.buffer),
    readWindow: async () => {
      throw new Error("no read");
    },
  });
  assert.equal(afterClose.getSnapshot().window, null);
  afterClose.release();

  const converted = await openLarge("/work/seed-convert.log");
  converted.store.getState().completeLargeTextAsText(converted.buffer.id, { text: "small" });
  const afterConvert = acquireFilesLargeTextWindow({
    owner: filesLargeTextWindowOwner(converted.buffer),
    readWindow: async () => {
      throw new Error("no read");
    },
  });
  assert.equal(afterConvert.getSnapshot().window, null);
  afterConvert.release();

  const renamed = await openLarge("/work/seed-rename.log");
  renamed.store.getState().applyFileMutation({
    workspace,
    kind: "rename",
    path: "/work/seed-rename.log",
    newPath: "/work/seed-renamed.log",
  });
  const afterRename = acquireFilesLargeTextWindow({
    owner: filesLargeTextWindowOwner(renamed.buffer),
    readWindow: async () => {
      throw new Error("no read");
    },
  });
  assert.equal(afterRename.getSnapshot().window, null);
  afterRename.release();
});

test("已打开 large 标签再次打开时重新决策：外部缩小后转为可编辑", async () => {
  const path = "/work/reopen-shrunk.log";
  let content = "head";
  let totalBytes = FILES_EDITABLE_TEXT_MAX_BYTES + 1;
  let reads = 0;
  const reader = {
    async readTextFileWindow(request: { path: string; offset?: number }): Promise<FileTextWindow> {
      reads += 1;
      const bytes = Buffer.from(content, "utf8");
      const offset = Math.min(request.offset ?? 0, bytes.length);
      const nextOffset = bytes.length;
      return {
        path: request.path,
        content: bytes.subarray(offset).toString("utf8"),
        offset,
        bytesRead: nextOffset - offset,
        nextOffset,
        totalBytes,
        version: "v1",
        isBinary: false,
        eof: nextOffset >= totalBytes,
        truncated: nextOffset < totalBytes,
      };
    },
  };
  const { controller, store } = renderController(servicesWith(reader));

  await controller.openExistingPath(workspace, path);
  const large = store.getState().buffers[0]!;
  assert.ok(large.kind === "large-text");
  assert.equal(reads, 1);

  content = "small";
  totalBytes = 5;
  await controller.openExistingPath(workspace, path);
  await flushAsync();

  const buffer = store.getState().buffers[0]!;
  assert.ok(buffer.kind === "text");
  assert.equal(buffer.text, "small");
  assert.equal(buffer.savedText, "small");
  assert.equal(canSaveFilesBuffer(buffer), true);
  assert.equal(reads, 2);
});

test("文件树重开已打开 large 标签时，pendingOpen 不会提前使读取结果失效", async () => {
  const path = "/work/reopen-with-request.log";
  let content = "head";
  let totalBytes = FILES_EDITABLE_TEXT_MAX_BYTES + 1;
  let reads = 0;
  const reader = {
    async readTextFileWindow(request: { path: string; offset?: number }): Promise<FileTextWindow> {
      reads += 1;
      const bytes = Buffer.from(content, "utf8");
      const offset = Math.min(request.offset ?? 0, bytes.length);
      const nextOffset = bytes.length;
      return {
        path: request.path,
        content: bytes.subarray(offset).toString("utf8"),
        offset,
        bytesRead: nextOffset - offset,
        nextOffset,
        totalBytes,
        version: "v1",
        isBinary: false,
        eof: nextOffset >= totalBytes,
        truncated: nextOffset < totalBytes,
      };
    },
  };
  const { controller, store } = renderController(servicesWith(reader));

  await controller.openExistingPath(workspace, path);
  const initial = store.getState().buffers[0]!;
  assert.ok(initial.kind === "large-text");

  content = "small";
  totalBytes = 5;
  store.getState().requestOpenPath({ workspace, path });
  const request = store.getState().pendingOpen!;
  assert.equal(store.getState().beginPendingOpen(request), true);

  await controller.openExistingPath(workspace, path, "keep", request);
  // 与真实调用方一致：openExistingPath 返回后才结束 pending open。
  store.getState().completePendingOpen(request);

  const buffer = store.getState().buffers[0]!;
  assert.ok(buffer.kind === "text");
  assert.equal(buffer.text, "small");
  assert.equal(buffer.savedText, "small");
  assert.equal(reads, 2);
});

test("显式重开仍为 large 时交付新首窗，已挂载 lease 不被替换且不重读", async () => {
  const path = "/work/reopen-same-large.log";
  let version = "v1";
  let content = "head-v1";
  const totalBytes = FILES_EDITABLE_TEXT_MAX_BYTES + 1;
  let reads = 0;
  const reader = {
    async readTextFileWindow(request: { path: string; offset?: number }): Promise<FileTextWindow> {
      reads += 1;
      const bytes = Buffer.from(content, "utf8");
      const offset = Math.min(request.offset ?? 0, bytes.length);
      const nextOffset = bytes.length;
      return {
        path: request.path,
        content: bytes.subarray(offset).toString("utf8"),
        offset,
        bytesRead: nextOffset - offset,
        nextOffset,
        totalBytes,
        version,
        isBinary: false,
        eof: nextOffset >= totalBytes,
        truncated: nextOffset < totalBytes,
      };
    },
  };
  const { controller, store } = renderController(servicesWith(reader));

  await controller.openExistingPath(workspace, path);
  const large = store.getState().buffers[0]!;
  assert.ok(large.kind === "large-text");
  let viewerReads = 0;
  const lease = acquireFilesLargeTextWindow({
    owner: filesLargeTextWindowOwner(large),
    initialTotalBytes: large.totalBytes,
    readWindow: async () => {
      viewerReads += 1;
      throw new Error("seeded window should not be reread");
    },
  });
  assert.equal(lease.getSnapshot().window?.content, "head-v1");
  lease.ensureLoaded();
  assert.equal(viewerReads, 0);

  version = "v2";
  content = "head-v2";
  await controller.openExistingPath(workspace, path);

  const snapshot = lease.getSnapshot();
  assert.equal(snapshot.phase, "ready");
  assert.equal(snapshot.window?.content, "head-v2");
  assert.equal(snapshot.window?.version, "v2");
  assert.equal(reads, 2);
  assert.equal(viewerReads, 0);
  lease.release();
});

test("首窗提前 EOF 或后续窗口 eof 与 nextOffset 不一致时整次读取失败", async () => {
  const earlyFirstEof = {
    readTextFileWindow: async (): Promise<FileTextWindow> => ({
      path: "/work/malformed.txt",
      content: "x",
      offset: 0,
      bytesRead: 1,
      nextOffset: 1,
      totalBytes: 100,
      version: "v1",
      isBinary: false,
      eof: true,
      truncated: false,
    }),
  };
  await assert.rejects(
    readFilesTextForOpen(earlyFirstEof, "/work/malformed.txt"),
    /ended inconsistently/,
  );

  let call = 0;
  const inconsistentNext = {
    readTextFileWindow: async (): Promise<FileTextWindow> => {
      call += 1;
      return {
        path: "/work/malformed-next.txt",
        content: "x",
        offset: call === 1 ? 0 : 1,
        bytesRead: 1,
        nextOffset: call === 1 ? 1 : 10,
        totalBytes: 10,
        version: "v1",
        isBinary: false,
        eof: false,
        truncated: true,
      };
    },
  };
  await assert.rejects(
    readFilesTextForOpen(inconsistentNext, "/work/malformed-next.txt"),
    /ended inconsistently/,
  );
});

test("恢复 large-text 标签时磁盘已变二进制则原 ID 转预览", async () => {
  const path = "/work/restored-binary.unknown";
  const id = filesFileBufferId(workspace, path);
  const store = createFilesEditorStore();
  store.getState().hydrateSession(sessionWithLargeTab(id, path));
  const reader = createWindowReader("\u0000binary", { isBinary: true });
  const loader = captureRestore(store, servicesWith(reader));

  await loader.loadRestoredTextFile(id);

  const buffer = store.getState().buffers[0]!;
  assert.equal(buffer.kind, "preview");
  assert.equal(buffer.id, id);
  assert.equal(canSaveFilesBuffer(buffer), false);
});

test("恢复大文本期间改名后，旧读取结果不得写回旧路径", async () => {
  const path = "/work/old.log";
  const id = filesFileBufferId(workspace, path);
  const store = createFilesEditorStore();
  store.getState().hydrateSession(sessionWithLargeTab(id, path));
  let resolveRead!: (value: FileTextWindow) => void;
  const reader = {
    calls: 0,
    readTextFileWindow: () => {
      reader.calls += 1;
      return new Promise<FileTextWindow>((resolve) => {
        resolveRead = resolve;
      });
    },
  };
  const loader = captureRestore(store, servicesWith(reader));

  const loading = loader.loadRestoredTextFile(id);
  await Promise.resolve();
  store.getState().applyFileMutation({ workspace, kind: "rename", path, newPath: "/work/new.log" });
  resolveRead({
    path,
    content: "stale",
    offset: 0,
    bytesRead: 5,
    nextOffset: 5,
    totalBytes: 5,
    version: "v1",
    isBinary: false,
    eof: true,
    truncated: false,
  });
  await loading;

  const state = store.getState();
  assert.equal(
    state.buffers.some((buffer) => buffer.path === path),
    false,
  );
  const renamed = state.buffers[0]!;
  assert.equal(renamed.path, "/work/new.log");
  assert.equal(renamed.kind, "large-text");
});

test("持久化接受 large-text 标签并保留旧草稿的 truncated 标记", () => {
  const largeId = filesFileBufferId(workspace, "/work/huge.log");
  const draftId = "untitled:legacy";
  const raw = JSON.stringify({
    version: 1,
    activeId: largeId,
    openFileIds: [largeId, draftId],
    openTabs: [{ id: largeId, kind: "large-text", path: "/work/huge.log", workspace }],
    drafts: [
      {
        id: draftId,
        path: "/work/legacy.txt",
        title: "legacy.txt",
        text: "partial",
        savedText: "whole",
        workspace,
        untitled: false,
        truncated: true,
      },
    ],
  });

  const session = readFilesEditorSession({ getItem: () => raw, setItem: () => undefined });

  assert.ok(session);
  assert.equal(session.openTabs[0]?.kind, "large-text");
  assert.equal(session.drafts[0]?.truncated, true);
});

test("删除大文本标签时不保留可保存的旧路径缓冲", () => {
  const path = "/work/huge.log";
  const store = createFilesEditorStore();
  store
    .getState()
    .openBuffer(createLargeTextFileBuffer({ workspace, path, totalBytes: 9 * 1024 * 1024 }));

  store.getState().applyFileMutation({ workspace, kind: "delete", path });

  const state = store.getState();
  assert.equal(state.buffers.length, 0);
  assert.equal(state.openIds.length, 0);
  assert.equal(
    state.buffers.some((buffer: FilesBuffer) => buffer.path === path),
    false,
  );
});
