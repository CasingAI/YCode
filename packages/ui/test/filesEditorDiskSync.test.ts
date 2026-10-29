import assert from "node:assert/strict";
import test from "node:test";
import { FILE_TEXT_WINDOW_CHANGED_CODE, type FileTextWindow } from "@zcode/shared";
import {
  collectFilesDiskSyncGroups,
  filesDiskSyncGroupsKey,
  isFilesDiskOfflineError,
  isFilesDiskWatchEventForPath,
  normalizeFilesDiskWatchPath,
  probeFilesDiskBuffer,
  resolveFilesDiskProbeOutcome,
  resolveFilesDiskWatchDirectory,
} from "../src/files-workbench/filesEditorDiskSync.js";
import {
  createLargeTextFileBuffer,
  createTextFileBuffer,
} from "../src/files-workbench/filesEditorModel.js";
import { createFilesEditorStore } from "../src/files-workbench/filesEditorStore.js";
import type {
  FilesEditorStore,
} from "../src/files-workbench/filesEditorStore.js";
import type {
  FilesWorkspaceRef,
} from "../src/files-workbench/filesEditorTypes.js";

const workspace: FilesWorkspaceRef = { workspacePath: "/work" };

function windowOf(path: string, content: string, version: string): FileTextWindow {
  return {
    path,
    content,
    offset: 0,
    bytesRead: Buffer.byteLength(content),
    nextOffset: Buffer.byteLength(content),
    totalBytes: Buffer.byteLength(content),
    version,
    isBinary: false,
    eof: true,
    truncated: false,
  };
}

function openCleanText(store: FilesEditorStore, path: string, version = "v1") {
  store.getState().openBuffer(createTextFileBuffer({ workspace, path, text: "draft" }));
  const buffer = store.getState().buffers.at(-1)!;
  store.getState().markSaved(buffer.id, { path, text: "draft", workspace, version });
  return store.getState().buffers.at(-1)!;
}

function createVersionedReader(initialVersion: string, path: string) {
  let version = initialVersion;
  const calls: Array<{ path: string; expectedVersion?: string }> = [];
  return {
    calls,
    setVersion: (next: string) => {
      version = next;
    },
    readTextFileWindow: async (request: { path: string; expectedVersion?: string }) => {
      calls.push(request);
      if (request.expectedVersion !== undefined && request.expectedVersion !== version) {
        throw Object.assign(new Error("changed"), { code: FILE_TEXT_WINDOW_CHANGED_CODE });
      }
      return windowOf(path, `content-${version}`, version);
    },
  };
}

function probe(
  store: FilesEditorStore,
  bufferId: string,
  fileService: { readTextFileWindow: (request: never) => Promise<FileTextWindow> },
  options?: { isCurrentRequest?: () => boolean; isSaving?: () => boolean },
) {
  return probeFilesDiskBuffer({
    store,
    bufferId,
    fileService: fileService as never,
    isCurrentRequest: options?.isCurrentRequest ?? (() => true),
    isSaving: options?.isSaving ?? (() => false),
  });
}

test("目录 watcher 按目录分组，忽略大文件、未加载和未激活缓冲", () => {
  const store = createFilesEditorStore();
  const a = openCleanText(store, "/work/src/a.ts");
  const b = openCleanText(store, "/work/src/b.ts");
  const c = openCleanText(store, "/work/docs/c.md");
  const large = openCleanText(store, "/work/src/lazy.ts");
  store.getState().setTextLoadState(large.id, "unloaded");
  const huge = createLargeTextFileBuffer({
    workspace,
    path: "/work/src/huge.log",
    totalBytes: 9 * 1024 * 1024,
  });
  store.getState().openBuffer(huge);

  // 每个分组只把 active view 计入监视；构造两个组分别激活 a / b。
  const groups = collectFilesDiskSyncGroups({
    buffers: store.getState().buffers,
    layout: {
      root: {
        type: "branch",
        id: "branch",
        direction: "horizontal",
        children: [
          { type: "leaf", groupId: "g1" },
          { type: "leaf", groupId: "g2" },
        ],
        ratio: 0.5,
      },
      groups: {
        g1: { id: "g1", views: [{ id: "view-a", bufferId: a.id }], activeViewId: "view-a" },
        g2: { id: "g2", views: [{ id: "view-b", bufferId: b.id }], activeViewId: "view-b" },
      },
      focusedGroupId: "g1",
    },
  });
  const src = groups.find((group) => group.directory === "/work/src");
  assert.ok(src);
  assert.deepEqual(
    src.targets.map((target) => target.path).sort(),
    ["/work/src/a.ts", "/work/src/b.ts"],
  );
  assert.equal(filesDiskSyncGroupsKey(groups).split("\n").length, 1);
  assert.equal(
    groups.flatMap((group) => group.targets).some((target) => target.id === c.id),
    false,
  );
});

test("目录与事件路径比较兼容 Windows 分隔符和盘符大小写", () => {
  assert.equal(resolveFilesDiskWatchDirectory("C:\\work\\a.txt"), "C:\\work");
  assert.equal(resolveFilesDiskWatchDirectory("C:\\a.txt"), "C:\\");
  assert.equal(resolveFilesDiskWatchDirectory("/work/a.txt"), "/work");
  assert.equal(normalizeFilesDiskWatchPath("C:\\Work\\A.txt"), "c:/work/a.txt");
  assert.equal(
    isFilesDiskWatchEventForPath({ changedPath: "C:\\Work\\A.txt" }, "c:/work/a.txt"),
    true,
  );
  // 目录级事件没有 changedPath 时保守视为可能命中。
  assert.equal(isFilesDiskWatchEventForPath({}, "/work/a.txt"), true);
  assert.equal(
    isFilesDiskWatchEventForPath({ changedPath: "/work/other.txt" }, "/work/a.txt"),
    false,
  );
});

test("探测结果映射：删除优先、离线跳过、同版本不变、脏稿只提示", () => {
  assert.equal(
    resolveFilesDiskProbeOutcome({ sameVersion: false, dirty: true, missing: true, offline: true }),
    "deleted",
  );
  assert.equal(
    resolveFilesDiskProbeOutcome({ sameVersion: false, dirty: false, missing: false, offline: true }),
    "skip",
  );
  assert.equal(
    resolveFilesDiskProbeOutcome({ sameVersion: true, dirty: true, missing: false, offline: false }),
    "unchanged",
  );
  assert.equal(
    resolveFilesDiskProbeOutcome({ sameVersion: false, dirty: true, missing: false, offline: false }),
    "changed",
  );
  assert.equal(
    resolveFilesDiskProbeOutcome({ sameVersion: false, dirty: false, missing: false, offline: false }),
    "reload",
  );
  assert.equal(isFilesDiskOfflineError({ code: "ECONNREFUSED" }), true);
  assert.equal(isFilesDiskOfflineError({ code: "ENOENT" }), false);
});

test("版本未变时清除旧提示，不改正文", async () => {
  const store = createFilesEditorStore();
  const buffer = openCleanText(store, "/work/same.txt");
  store.getState().setTextExternalChange(buffer.id, { kind: "changed", observedVersion: "v0" });
  const reader = createVersionedReader("v1", "/work/same.txt");

  const result = await probe(store, buffer.id, reader);

  assert.equal(result.kind, "unchanged");
  const current = store.getState().buffers[0]!;
  assert.ok(current.kind === "text");
  assert.equal(current.text, "draft");
  assert.equal(current.externalChange, undefined);
});

test("干净缓冲发现新版本返回 reload，由 controller 统一重载", async () => {
  const store = createFilesEditorStore();
  const buffer = openCleanText(store, "/work/clean.txt");
  const reader = createVersionedReader("v2", "/work/clean.txt");

  const result = await probe(store, buffer.id, reader);

  assert.equal(result.kind, "reload");
  // 版本不匹配时补读一次拿到实际版本，避免只凭 expectedVersion 失败下结论。
  assert.equal(reader.calls.length, 2);
  assert.equal(reader.calls[1]?.expectedVersion, undefined);
  const current = store.getState().buffers[0]!;
  assert.ok(current.kind === "text");
  assert.equal(current.text, "draft");
});

test("脏缓冲发现外部修改只提示 observedVersion，不改正文或 diskVersion", async () => {
  const store = createFilesEditorStore();
  const buffer = openCleanText(store, "/work/dirty.txt");
  store.getState().updateText(buffer.id, "local edit");
  const reader = createVersionedReader("v2", "/work/dirty.txt");

  const result = await probe(store, buffer.id, reader);

  assert.equal(result.kind, "changed");
  const current = store.getState().buffers[0]!;
  assert.ok(current.kind === "text");
  assert.equal(current.text, "local edit");
  assert.equal(current.diskVersion, "v1");
  assert.deepEqual(current.externalChange, { kind: "changed", observedVersion: "v2" });
});

test("ENOENT 标记删除并保留草稿；离线与读取失败不当作删除", async () => {
  const store = createFilesEditorStore();
  const deletedBuffer = openCleanText(store, "/work/deleted.txt");
  const missing = await probe(store, deletedBuffer.id, {
    readTextFileWindow: async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.equal(missing.kind, "deleted");
  let current = store.getState().buffers[0]!;
  assert.ok(current.kind === "text");
  assert.equal(current.text, "draft");
  assert.deepEqual(current.externalChange, { kind: "deleted", observedVersion: null });

  const other = openCleanText(store, "/work/offline.txt");
  const offline = await probe(store, other.id, {
    readTextFileWindow: async () => {
      throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" });
    },
  });
  assert.equal(offline.kind, "skipped");
  current = store.getState().buffers.find((buffer) => buffer.id === other.id)!;
  assert.ok(current.kind === "text");
  assert.equal(current.externalChange, undefined);
});

test("正在保存或请求已过期时 probe 直接跳过", async () => {
  const store = createFilesEditorStore();
  const buffer = openCleanText(store, "/work/saving.txt");
  let reads = 0;
  const fileService = {
    readTextFileWindow: async () => {
      reads += 1;
      return windowOf("/work/saving.txt", "x", "v2");
    },
  };

  assert.equal((await probe(store, buffer.id, fileService, { isSaving: () => true })).kind, "skipped");
  assert.equal(reads, 0);
  assert.equal(
    (await probe(store, buffer.id, fileService, { isCurrentRequest: () => false })).kind,
    "skipped",
  );
  assert.equal(reads, 1);
  const current = store.getState().buffers[0]!;
  assert.ok(current.kind === "text");
  assert.equal(current.externalChange, undefined);
});
