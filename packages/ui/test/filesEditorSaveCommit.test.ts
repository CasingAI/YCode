import assert from "node:assert/strict";
import test from "node:test";
import {
  FILE_TEXT_COMMIT_CONFLICT_CODE,
  FILE_TEXT_WINDOW_CHANGED_CODE,
  type CommitTextFileParams,
  type CommitTextFileResult,
  type FileTextWindow,
} from "@zcode/shared";
import {
  createLargeTextFileBuffer,
  createTextFileBuffer,
} from "../src/files-workbench/filesEditorModel.js";
import {
  FILES_LARGE_TEXT_BLOCK_STEP,
  filesLargeTextNominalBlockStart,
} from "../src/files-workbench/filesLargeTextBlockModel.js";
import {
  acquireFilesLargeTextWindow,
  seedFilesLargeTextWindow,
  type FilesLargeTextWindowReadParams,
} from "../src/files-workbench/filesLargeTextWindowStore.js";
import { filesLargeTextWindowOwner } from "../src/files-workbench/filesLargeTextWindowSeed.js";
import {
  saveFilesTextBuffer,
  type FilesSaveConflictInfo,
} from "../src/files-workbench/filesEditorSaveIO.js";
import { createFilesEditorStore } from "../src/files-workbench/filesEditorStore.js";
import type { FilesEditorStore } from "../src/files-workbench/filesEditorStore.js";
import type { FilesBuffer, FilesWorkspaceRef } from "../src/files-workbench/filesEditorTypes.js";

const workspace: FilesWorkspaceRef = { workspacePath: "/work" };

function windowOf(
  path: string,
  content: string,
  version: string,
  totalBytes = Buffer.byteLength(content),
): FileTextWindow {
  return {
    path,
    content,
    offset: 0,
    bytesRead: Buffer.byteLength(content),
    nextOffset: totalBytes,
    totalBytes,
    version,
    isBinary: false,
    eof: true,
    truncated: false,
  };
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function largeWindowAt(params: {
  path: string;
  offset: number;
  version: string;
  totalBytes: number;
  content?: string;
}): FileTextWindow {
  const content = params.content ?? "";
  const bytesRead = Buffer.byteLength(content);
  return {
    path: params.path,
    content,
    offset: params.offset,
    bytesRead,
    nextOffset: params.offset + bytesRead,
    totalBytes: params.totalBytes,
    version: params.version,
    isBinary: false,
    eof: false,
    truncated: false,
  };
}

function createCommitRecorder(result: (params: CommitTextFileParams) => CommitTextFileResult) {
  const calls: CommitTextFileParams[] = [];
  return {
    calls,
    commitTextFile: async (params: CommitTextFileParams) => {
      calls.push(params);
      return result(params);
    },
  };
}

function saveOptions(options: {
  store: FilesEditorStore;
  buffer: FilesBuffer;
  path: string;
  fileService: Parameters<typeof saveFilesTextBuffer>[0]["fileService"];
  onConflict?: (info: FilesSaveConflictInfo) => void;
  force?: boolean;
  observedVersion?: string | null;
  targetVersion?: string | null;
  recreate?: boolean;
}) {
  const failed: string[] = [];
  const conflicts: FilesSaveConflictInfo[] = [];
  const saved: Array<{ path: string; previousPath: string | undefined }> = [];
  return {
    failed,
    conflicts,
    saved,
    promise: saveFilesTextBuffer({
      store: options.store,
      buffer: options.buffer,
      path: options.path,
      force: options.force,
      observedVersion: options.observedVersion,
      targetVersion: options.targetVersion,
      recreate: options.recreate,
      fileService: options.fileService,
      onConflict: (info) => {
        conflicts.push(info);
        options.onConflict?.(info);
      },
      onSaveFailed: (path) => failed.push(path),
      onBusy: () => undefined,
      onSaved: (value) => saved.push(value),
    }),
  };
}

test("普通文本按 diskVersion 提交完整正文，保存期间的新输入不会被清掉", async () => {
  const path = "/work/save-version.txt";
  const store = createFilesEditorStore();
  store.getState().openBuffer(createTextFileBuffer({ workspace, path, text: "one" }));
  const id = store.getState().buffers[0]!.id;
  store.getState().markSaved(id, { path, text: "one", workspace, version: "v1" });
  store.getState().updateText(id, "two");

  let resolveCommit!: (result: CommitTextFileResult) => void;
  let commitParams: CommitTextFileParams | undefined;
  const saving = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path,
    fileService: {
      readTextFileWindow: async () => windowOf(path, "one", "v1"),
      commitTextFile: (params) => {
        commitParams = params;
        return new Promise((resolve) => {
          resolveCommit = resolve;
        });
      },
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  store.getState().updateText(id, "three");
  resolveCommit({ path, version: "v2", totalBytes: 5 });

  assert.equal(await saving.promise, true);
  assert.deepEqual(commitParams?.write, { kind: "full", text: "two" });
  assert.equal(commitParams?.expectedVersion, "v1");
  const current = store.getState().buffers[0]!;
  assert.ok(current.kind === "text");
  assert.equal(current.text, "three");
  assert.equal(current.savedText, "two");
  assert.equal(current.diskVersion, "v2");
  assert.deepEqual(saving.saved, [{ path, previousPath: path }]);
});

test("提交冲突携带探测到的 observedVersion，供弹窗覆盖绑定同一版", async () => {
  const path = "/work/conflict.txt";
  const store = createFilesEditorStore();
  store.getState().openBuffer(createTextFileBuffer({ workspace, path, text: "draft" }));
  const id = store.getState().buffers[0]!.id;
  store.getState().markSaved(id, { path, text: "base", workspace, version: "v1" });
  store.getState().updateText(id, "draft");

  const saving = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path,
    fileService: {
      readTextFileWindow: async () => windowOf(path, "external", "v2"),
      commitTextFile: async () => {
        throw Object.assign(new Error("conflict"), { code: FILE_TEXT_COMMIT_CONFLICT_CODE });
      },
    },
  });

  assert.equal(await saving.promise, false);
  assert.equal(saving.conflicts.length, 1);
  assert.equal(saving.conflicts[0]?.deleted, false);
  assert.equal(saving.conflicts[0]?.observedVersion, "v2");
  assert.deepEqual(saving.failed, []);
  const current = store.getState().buffers[0]!;
  assert.ok(current.kind === "text");
  assert.equal(current.savedText, "base");
  assert.equal(current.diskVersion, "v1");
});

test("提交冲突时磁盘已删除只提示删除，不重建文件", async () => {
  const path = "/work/deleted.txt";
  const store = createFilesEditorStore();
  store.getState().openBuffer(createTextFileBuffer({ workspace, path, text: "draft" }));
  const id = store.getState().buffers[0]!.id;
  store.getState().markSaved(id, { path, text: "base", workspace, version: "v1" });
  store.getState().updateText(id, "draft");

  const saving = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path,
    fileService: {
      readTextFileWindow: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      commitTextFile: async () => {
        throw Object.assign(new Error("conflict"), { code: FILE_TEXT_COMMIT_CONFLICT_CODE });
      },
    },
  });

  assert.equal(await saving.promise, false);
  assert.equal(saving.conflicts[0]?.deleted, true);
  assert.equal(saving.conflicts[0]?.observedVersion, null);
});

test("删除确认后的显式重建使用 null 版本，普通覆盖不会循环", async () => {
  const path = "/work/recreate.txt";
  const store = createFilesEditorStore();
  store.getState().openBuffer(createTextFileBuffer({ workspace, path, text: "draft" }));
  const id = store.getState().buffers[0]!.id;
  store.getState().markSaved(id, { path, text: "base", workspace, version: "v1" });
  store.getState().updateText(id, "draft");

  const commits = createCommitRecorder(() => ({ path, version: "v2", totalBytes: 5 }));
  const fileService = {
    ...commits,
    readTextFileWindow: async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  };
  const refused = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path,
    observedVersion: null,
    fileService,
  });
  assert.equal(await refused.promise, false);
  assert.equal(commits.calls.length, 0);
  assert.equal(refused.conflicts[0]?.deleted, true);

  const recreated = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path,
    force: true,
    recreate: true,
    observedVersion: null,
    fileService,
  });
  assert.equal(await recreated.promise, true);
  assert.equal(commits.calls[0]?.expectedVersion, null);
  assert.equal(commits.calls[0]?.sourcePath, undefined);
  assert.deepEqual(commits.calls[0]?.write, { kind: "full", text: "draft" });
  assert.equal(recreated.conflicts.length, 0);
});

test("覆盖只绑定弹窗 observedVersion；磁盘再次变化时不盲 force", async () => {
  const path = "/work/overwrite.txt";
  const store = createFilesEditorStore();
  store.getState().openBuffer(createTextFileBuffer({ workspace, path, text: "draft" }));
  const id = store.getState().buffers[0]!.id;
  store.getState().markSaved(id, { path, text: "base", workspace, version: "v1" });
  store.getState().updateText(id, "draft");

  const commits = createCommitRecorder(() => ({ path, version: "v3", totalBytes: 5 }));
  const saving = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path,
    force: true,
    observedVersion: "v2",
    fileService: {
      ...commits,
      readTextFileWindow: async () => windowOf(path, "external", "v2"),
    },
  });

  assert.equal(await saving.promise, true);
  assert.equal(commits.calls[0]?.expectedVersion, "v2");
  assert.equal(commits.calls[0]?.write.kind, "full");
});

test("探测目标期间 diskVersion 已变化时放弃提交，不用旧基准覆盖", async () => {
  const source = "/work/guard-source.txt";
  const target = "/work/guard-target.txt";
  const store = createFilesEditorStore();
  store.getState().openBuffer(createTextFileBuffer({ workspace, path: source, text: "draft" }));
  const id = store.getState().buffers[0]!.id;
  store.getState().markSaved(id, { path: source, text: "draft", workspace, version: "v1" });

  let resolveProbe!: (window: FileTextWindow) => void;
  const commits = createCommitRecorder((params) => ({
    path: params.path,
    version: "v4",
    totalBytes: 5,
  }));
  const saving = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path: target,
    fileService: {
      ...commits,
      readTextFileWindow: () =>
        new Promise<FileTextWindow>((resolve) => {
          resolveProbe = resolve;
        }),
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  store.getState().markSaved(id, { path: source, text: "draft", workspace, version: "v2" });
  resolveProbe(windowOf(target, "", "target-v1", 0));

  assert.equal(await saving.promise, false);
  assert.equal(commits.calls.length, 0);
  const current = store.getState().buffers[0]!;
  assert.ok(current.kind === "text");
  assert.equal(current.diskVersion, "v2");
});

test("另存为探测到已有目标必须先确认，确认后同时绑定源与目标版本", async () => {
  const source = "/work/source.txt";
  const target = "/work/target.txt";
  const store = createFilesEditorStore();
  store.getState().openBuffer(createTextFileBuffer({ workspace, path: source, text: "draft" }));
  const id = store.getState().buffers[0]!.id;
  store.getState().markSaved(id, { path: source, text: "draft", workspace, version: "source-v1" });

  const versions = new Map([
    [source, "source-v1"],
    [target, "target-v7"],
  ]);
  const commits = createCommitRecorder((params) => ({
    path: params.path,
    version: "saved-v8",
    totalBytes: 5,
  }));
  const fileService = {
    ...commits,
    readTextFileWindow: async ({ path }: { path: string }) => {
      const version = versions.get(path);
      if (!version) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return windowOf(path, "disk", version);
    },
  };

  const first = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path: target,
    fileService,
  });
  assert.equal(await first.promise, false);
  assert.equal(commits.calls.length, 0);
  assert.equal(first.conflicts[0]?.deleted, false);
  assert.equal(first.conflicts[0]?.observedVersion, "source-v1");
  assert.equal(first.conflicts[0]?.targetVersion, "target-v7");
  assert.equal(store.getState().buffers[0]?.path, source);

  const confirmed = saveOptions({
    store,
    buffer: first.conflicts[0]!.buffer,
    path: target,
    fileService,
    force: true,
    observedVersion: first.conflicts[0]!.observedVersion,
    targetVersion: first.conflicts[0]!.targetVersion,
  });
  assert.equal(await confirmed.promise, true);
  assert.equal(commits.calls[0]?.expectedVersion, "source-v1");
  assert.equal(commits.calls[0]?.sourcePath, source);
  assert.equal(commits.calls[0]?.expectedTargetVersion, "target-v7");
  assert.equal(store.getState().buffers[0]?.path, target);

  // 显式另存为到不存在的新目标仍可直接新建，不带版本覆盖确认。
  const missingTarget = "/work/new-target.txt";
  const missing = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path: missingTarget,
    fileService: {
      ...createCommitRecorder((params) => ({
        path: params.path,
        version: "created-v1",
        totalBytes: 5,
      })),
      readTextFileWindow: async ({ path }) => {
        if (path === target) return windowOf(path, "disk", "target-v7");
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    },
  });
  assert.equal(await missing.promise, true);
  assert.equal(missing.conflicts.length, 0);
});

test("SaveAs 探测时目标不存在、提交时却已存在，覆盖仍绑定最新目标版本", async () => {
  const source = "/work/as-source.txt";
  const target = "/work/as-target.txt";
  const store = createFilesEditorStore();
  store.getState().openBuffer(createTextFileBuffer({ workspace, path: source, text: "draft" }));
  const id = store.getState().buffers[0]!.id;
  store.getState().markSaved(id, { path: source, text: "draft", workspace, version: "source-v1" });

  let targetReads = 0;
  const commits: CommitTextFileParams[] = [];
  const fileService = {
    readTextFileWindow: async ({ path }: { path: string }) => {
      if (path === source) return windowOf(path, "source", "source-v1");
      targetReads += 1;
      // 提交前探测目标不存在；提交冲突后探测到 v4：再次覆盖必须绑定 v4。
      if (targetReads === 1) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return windowOf(path, "target", "target-v4");
    },
    commitTextFile: async (params: CommitTextFileParams) => {
      commits.push(params);
      if (commits.length === 1) {
        throw Object.assign(new Error("conflict"), { code: FILE_TEXT_COMMIT_CONFLICT_CODE });
      }
      return { path: params.path, version: "target-v5", totalBytes: 5 };
    },
  };
  const first = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path: target,
    fileService,
  });

  assert.equal(await first.promise, false);
  const conflict = first.conflicts[0]!;
  assert.equal(conflict.path, target);
  assert.equal(conflict.observedVersion, "source-v1");
  assert.equal(conflict.targetVersion, "target-v4");

  const retry = saveOptions({
    store,
    buffer: conflict.buffer,
    path: conflict.path,
    fileService,
    force: true,
    observedVersion: conflict.observedVersion,
    targetVersion: conflict.targetVersion,
  });
  assert.equal(await retry.promise, true);
  assert.equal(commits[1]?.path, target);
  assert.equal(commits[1]?.sourcePath, source);
  assert.equal(commits[1]?.expectedVersion, "source-v1");
  assert.equal(commits[1]?.expectedTargetVersion, "target-v4");
  assert.equal(store.getState().buffers[0]?.path, target);
});

test("未命名缓冲显式另存为只要求目标不存在，不带 sourcePath", async () => {
  const store = createFilesEditorStore();
  const id = store.getState().createUntitled(workspace);
  store.getState().updateText(id, "draft");
  const commits = createCommitRecorder(() => ({
    path: "/work/untitled.txt",
    version: "created",
    totalBytes: 5,
  }));
  const saving = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path: "/work/untitled.txt",
    fileService: {
      ...commits,
      readTextFileWindow: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    },
  });

  assert.equal(await saving.promise, true);
  assert.equal(commits.calls[0]?.expectedVersion, null);
  assert.equal(commits.calls[0]?.sourcePath, undefined);
  assert.equal(commits.calls[0]?.expectedTargetVersion, undefined);
});

test("旧脏草稿没有 diskVersion 时先完整读盘比较，再以读到版本提交", async () => {
  const path = "/work/legacy.txt";
  const diskText = "disk text";
  const store = createFilesEditorStore();
  const buffer = {
    ...createTextFileBuffer({ workspace, path, text: "draft" }),
    savedText: diskText,
  };
  store.getState().openBuffer(buffer);
  const reads: Array<{ offset?: number }> = [];
  const commits = createCommitRecorder(() => ({ path, version: "v2", totalBytes: 5 }));
  const saving = saveOptions({
    store,
    buffer,
    path,
    fileService: {
      ...commits,
      readTextFileWindow: async (request) => {
        reads.push(request);
        return windowOf(path, diskText, "v1");
      },
    },
  });

  assert.equal(await saving.promise, true);
  assert.equal(reads.length, 1);
  assert.equal(commits.calls[0]?.expectedVersion, "v1");
  assert.equal(commits.calls[0]?.write.kind, "full");
});

test("旧脏草稿确认覆盖但版本探测失败时拒绝盲写并重新提示", async () => {
  const path = "/work/legacy-unknown-version.txt";
  const store = createFilesEditorStore();
  const buffer = {
    ...createTextFileBuffer({ workspace, path, text: "draft" }),
    savedText: "my baseline",
  };
  store.getState().openBuffer(buffer);
  const commits = createCommitRecorder(() => ({ path, version: "v2", totalBytes: 5 }));
  const saving = saveOptions({
    store,
    buffer,
    path,
    force: true,
    observedVersion: undefined,
    fileService: {
      ...commits,
      readTextFileWindow: async () => {
        throw Object.assign(new Error("remote unavailable"), { code: "ETIMEDOUT" });
      },
    },
  });

  assert.equal(await saving.promise, false);
  assert.equal(commits.calls.length, 0);
  assert.equal(saving.conflicts.length, 1);
  assert.equal(saving.conflicts[0]?.observedVersion, undefined);
  assert.equal(saving.conflicts[0]?.deleted, false);
});

test("旧脏草稿 force 覆盖时版本未知，即使读盘成功也重新提示且不提交", async () => {
  const path = "/work/legacy-unknown-success.txt";
  const store = createFilesEditorStore();
  const buffer = {
    ...createTextFileBuffer({ workspace, path, text: "draft" }),
    savedText: "my baseline",
  };
  store.getState().openBuffer(buffer);
  const commits = createCommitRecorder(() => ({ path, version: "v2", totalBytes: 5 }));
  const saving = saveOptions({
    store,
    buffer,
    path,
    force: true,
    observedVersion: undefined,
    fileService: {
      ...commits,
      readTextFileWindow: async () => windowOf(path, "my baseline", "v1"),
    },
  });

  assert.equal(await saving.promise, false);
  assert.equal(commits.calls.length, 0);
  assert.equal(saving.conflicts.length, 1);
  assert.equal(saving.conflicts[0]?.observedVersion, undefined);
  assert.equal(saving.conflicts[0]?.deleted, false);
});

test("旧脏草稿读盘内容与 savedText 不同则冲突，不盲写", async () => {
  const path = "/work/legacy-conflict.txt";
  const store = createFilesEditorStore();
  const buffer = {
    ...createTextFileBuffer({ workspace, path, text: "draft" }),
    savedText: "my baseline",
  };
  store.getState().openBuffer(buffer);
  const commits = createCommitRecorder(() => ({ path, version: "v2", totalBytes: 5 }));
  const saving = saveOptions({
    store,
    buffer,
    path,
    fileService: {
      ...commits,
      readTextFileWindow: async () => windowOf(path, "someone else", "v9"),
    },
  });

  assert.equal(await saving.promise, false);
  assert.equal(commits.calls.length, 0);
  assert.equal(saving.conflicts[0]?.observedVersion, "v9");
  assert.equal(saving.conflicts[0]?.deleted, false);
});

test("大文件提交基于 baseVersion 的块补丁，成功后重基线且无可见窗口时不额外读盘", async () => {
  const path = "/work/large.log";
  const store = createFilesEditorStore();
  const large = createLargeTextFileBuffer({ workspace, path, totalBytes: 10 });
  store.getState().openBuffer(large);
  store.getState().initializeLargeTextEdit(large.id, "v1", 10);
  store
    .getState()
    .updateLargeTextBlock(
      large.id,
      { blockIndex: 0, offset: 0, deleteBytes: 1, originalText: "a" },
      "b",
    );

  const commits = createCommitRecorder(() => ({ path, version: "v2", totalBytes: 1 }));
  const reads: Array<{ expectedVersion?: string }> = [];
  const saving = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path,
    fileService: {
      ...commits,
      readTextFileWindow: async (request) => {
        reads.push(request);
        return windowOf(path, "b", "v2", 1);
      },
    },
  });

  assert.equal(await saving.promise, true);
  assert.equal(commits.calls[0]?.expectedVersion, "v1");
  assert.deepEqual(commits.calls[0]?.write, {
    kind: "patches",
    patches: [{ offset: 0, deleteBytes: 1, text: "b" }],
  });
  // 展示读取与写盘解耦：没有可见 lease 时不在保存流程里额外读盘。
  assert.deepEqual(reads, []);
  const current = store.getState().buffers[0]!;
  assert.ok(current.kind === "large-text");
  assert.equal(current.edit?.baseVersion, "v2");
  assert.equal(current.edit?.baseTotalBytes, 1);
  assert.deepEqual(current.edit?.changes, []);
});

test("clean 大文件同路径保存为 no-op，另存为提交空补丁流式复制", async () => {
  const source = "/work/large-clean.log";
  const target = "/work/large-copy.log";
  const store = createFilesEditorStore();
  const large = createLargeTextFileBuffer({ workspace, path: source, totalBytes: 100 });
  store.getState().openBuffer(large);
  store.getState().initializeLargeTextEdit(large.id, "v1", 100);

  const samePathCommits = createCommitRecorder(() => ({
    path: source,
    version: "v2",
    totalBytes: 100,
  }));
  const samePath = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path: source,
    fileService: {
      ...samePathCommits,
      readTextFileWindow: async () => windowOf(source, "", "v1", 100),
    },
  });
  assert.equal(await samePath.promise, true);
  assert.equal(samePathCommits.calls.length, 0);
  assert.deepEqual(samePath.saved, []);

  const copyCommits = createCommitRecorder(() => ({
    path: target,
    version: "copy-v1",
    totalBytes: 100,
  }));
  const copy = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path: target,
    fileService: {
      ...copyCommits,
      readTextFileWindow: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    },
  });
  assert.equal(await copy.promise, true);
  assert.equal(copy.conflicts.length, 0);
  assert.deepEqual(copyCommits.calls[0]?.write, { kind: "patches", patches: [] });
  assert.equal(copyCommits.calls[0]?.expectedVersion, "v1");
  assert.equal(copyCommits.calls[0]?.sourcePath, source);
  assert.equal(copyCommits.calls[0]?.expectedTargetVersion, null);
});

test("大文件撤销全部修改后同路径保存同样 no-op", async () => {
  const path = "/work/large-undo.log";
  const store = createFilesEditorStore();
  const large = createLargeTextFileBuffer({ workspace, path, totalBytes: 10 });
  store.getState().openBuffer(large);
  store.getState().initializeLargeTextEdit(large.id, "v1", 10);
  store
    .getState()
    .updateLargeTextBlock(
      large.id,
      { blockIndex: 0, offset: 0, deleteBytes: 1, originalText: "a" },
      "b",
    );
  store.getState().undoLargeTextEdit(large.id);

  const commits = createCommitRecorder(() => ({ path, version: "v2", totalBytes: 10 }));
  const saving = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path,
    fileService: {
      ...commits,
      readTextFileWindow: async () => windowOf(path, "", "v1", 10),
    },
  });

  assert.equal(await saving.promise, true);
  assert.equal(commits.calls.length, 0);
});

test("大文件另存为目标已存在时，未确认 force 不覆盖；确认后绑定目标版本", async () => {
  const source = "/work/large-as-source.log";
  const target = "/work/large-as-target.log";
  const store = createFilesEditorStore();
  const large = createLargeTextFileBuffer({ workspace, path: source, totalBytes: 10 });
  store.getState().openBuffer(large);
  store.getState().initializeLargeTextEdit(large.id, "v1", 10);
  store
    .getState()
    .updateLargeTextBlock(
      large.id,
      { blockIndex: 0, offset: 0, deleteBytes: 1, originalText: "a" },
      "b",
    );

  const commits = createCommitRecorder((params) => ({
    path: params.path,
    version: "target-v5",
    totalBytes: 10,
  }));
  const fileService = {
    ...commits,
    readTextFileWindow: async ({ path }: { path: string }) =>
      path === source ? windowOf(path, "", "v1", 10) : windowOf(path, "", "target-v4", 10),
  };
  const first = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path: target,
    fileService,
  });
  assert.equal(await first.promise, false);
  assert.equal(commits.calls.length, 0);
  assert.equal(first.conflicts[0]?.targetVersion, "target-v4");
  assert.equal(first.conflicts[0]?.observedVersion, "v1");
  // 纯目标冲突可以显式确认目标版本，不能按源草稿冲突处理。
  assert.equal(first.conflicts[0]?.targetOnly, true);

  const confirmed = saveOptions({
    store,
    buffer: first.conflicts[0]!.buffer,
    path: target,
    force: true,
    observedVersion: first.conflicts[0]!.observedVersion,
    targetVersion: first.conflicts[0]!.targetVersion,
    fileService,
  });
  assert.equal(await confirmed.promise, true);
  assert.equal(commits.calls[0]?.expectedVersion, "v1");
  assert.equal(commits.calls[0]?.sourcePath, source);
  assert.equal(commits.calls[0]?.expectedTargetVersion, "target-v4");
  assert.deepEqual(commits.calls[0]?.write, {
    kind: "patches",
    patches: [{ offset: 0, deleteBytes: 1, text: "b" }],
  });
});

test("大文件探测目标期间 baseVersion 已变化时放弃提交", async () => {
  const source = "/work/large-base-source.log";
  const target = "/work/large-base-target.log";
  const store = createFilesEditorStore();
  const large = createLargeTextFileBuffer({ workspace, path: source, totalBytes: 10 });
  store.getState().openBuffer(large);
  store.getState().initializeLargeTextEdit(large.id, "v1", 10);
  store
    .getState()
    .updateLargeTextBlock(
      large.id,
      { blockIndex: 0, offset: 0, deleteBytes: 1, originalText: "a" },
      "b",
    );

  let resolveProbe!: (window: FileTextWindow) => void;
  const commits = createCommitRecorder((params) => ({
    path: params.path,
    version: "v2",
    totalBytes: 10,
  }));
  const saving = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path: target,
    fileService: {
      ...commits,
      readTextFileWindow: () =>
        new Promise<FileTextWindow>((resolve) => {
          resolveProbe = resolve;
        }),
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  store.getState().markLargeTextSaved(large.id, {
    path: source,
    version: "v9",
    totalBytes: 10,
  });
  resolveProbe(windowOf(target, "", "target-v1", 10));

  assert.equal(await saving.promise, false);
  assert.equal(commits.calls.length, 0);
  const current = store.getState().buffers[0]!;
  assert.ok(current.kind === "large-text");
  assert.equal(current.edit?.baseVersion, "v9");
});

test("大文件保存期间阻止跨分屏输入和历史操作，提交结束后恢复编辑", async () => {
  const path = "/work/large-during-save.log";
  const store = createFilesEditorStore();
  const large = createLargeTextFileBuffer({ workspace, path, totalBytes: 10 });
  store.getState().openBuffer(large);
  store.getState().initializeLargeTextEdit(large.id, "v1", 10);
  store
    .getState()
    .updateLargeTextBlock(
      large.id,
      { blockIndex: 0, offset: 0, deleteBytes: 1, originalText: "a" },
      "b",
    );

  let resolveCommit!: (result: CommitTextFileResult) => void;
  const saving = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path,
    fileService: {
      readTextFileWindow: async () => windowOf(path, "b", "v2", 1),
      commitTextFile: () =>
        new Promise((resolve) => {
          resolveCommit = resolve;
        }),
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  store
    .getState()
    .updateLargeTextBlock(
      large.id,
      { blockIndex: 0, offset: 0, deleteBytes: 1, originalText: "a" },
      "c",
    );
  let locked = store.getState().buffers[0]!;
  assert.ok(locked.kind === "large-text" && locked.saveToken);
  store.getState().undoLargeTextEdit(large.id);
  store.getState().redoLargeTextEdit(large.id);
  store.getState().discardLargeTextEdits(large.id);
  assert.equal(
    store.getState().restoreLargeTextEdit(large.id, {
      baseVersion: "v1",
      baseTotalBytes: 10,
      changes: [],
    }),
    false,
  );
  locked = store.getState().buffers[0]!;
  assert.ok(locked.kind === "large-text");
  assert.equal(locked.edit?.changes[0]?.text, "b");
  resolveCommit({ path, version: "v2", totalBytes: 1 });

  assert.equal(await saving.promise, true);
  const current = store.getState().buffers[0]!;
  assert.ok(current.kind === "large-text");
  assert.equal(current.saveToken, undefined);
  assert.equal(current.edit?.baseVersion, "v2");
  assert.deepEqual(current.edit?.changes, []);
  store
    .getState()
    .updateLargeTextBlock(
      large.id,
      { blockIndex: 0, offset: 0, deleteBytes: 1, originalText: "b" },
      "c",
    );
  const edited = store.getState().buffers[0]!;
  assert.ok(edited.kind === "large-text");
  assert.equal(edited.edit?.changes[0]?.text, "c");
});

test("大文件冲突不允许强套补丁，只回调冲突并保留草稿", async () => {
  const path = "/work/large-conflict.log";
  const store = createFilesEditorStore();
  const large = createLargeTextFileBuffer({ workspace, path, totalBytes: 10 });
  store.getState().openBuffer(large);
  store.getState().initializeLargeTextEdit(large.id, "v1", 10);
  store
    .getState()
    .updateLargeTextBlock(
      large.id,
      { blockIndex: 0, offset: 0, deleteBytes: 1, originalText: "a" },
      "b",
    );

  const saving = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path,
    force: true,
    fileService: {
      readTextFileWindow: async () => windowOf(path, "external", "v5"),
      commitTextFile: async () => {
        throw Object.assign(new Error("conflict"), { code: FILE_TEXT_COMMIT_CONFLICT_CODE });
      },
    },
  });

  assert.equal(await saving.promise, false);
  assert.equal(saving.conflicts.length, 1);
  assert.equal(saving.conflicts[0]?.observedVersion, "v5");
  // 同路径源版本冲突没有「确认目标版本覆盖」语义，只能取消或丢弃草稿重载。
  assert.equal(saving.conflicts[0]?.targetOnly, undefined);
  const current = store.getState().buffers[0]!;
  assert.ok(current.kind === "large-text");
  assert.equal(current.edit?.changes[0]?.text, "b");
});

test("旧 Host 缺少 commitTextFile 时明确失败，不回退 writeTextFile", async () => {
  const path = "/work/old-host.txt";
  const store = createFilesEditorStore();
  store.getState().openBuffer(createTextFileBuffer({ workspace, path, text: "draft" }));
  const writes: string[] = [];
  const saving = saveOptions({
    store,
    buffer: store.getState().buffers[0]!,
    path,
    fileService: {
      readTextFileWindow: async () => windowOf(path, "draft", "v1"),
      writeTextFile: async () => {
        writes.push("write");
      },
    } as never,
  });

  assert.equal(await saving.promise, false);
  assert.deepEqual(writes, []);
  assert.deepEqual(saving.failed, [path]);
});

test("保存成功后按新版本规范块起点重载当前块，不复用旧实际 offset", async () => {
  const path = "/work/large-reload.log";
  const totalBytes = FILES_LARGE_TEXT_BLOCK_STEP * 3 + 100;
  const blockIndex = 2;
  const nominalStart = filesLargeTextNominalBlockStart(blockIndex);
  const store = createFilesEditorStore();
  const large = createLargeTextFileBuffer({ workspace, path, totalBytes });
  store.getState().openBuffer(large);
  store.getState().initializeLargeTextEdit(large.id, "v1", totalBytes);

  const owner = filesLargeTextWindowOwner(store.getState().buffers[0]! as never);
  // 旧窗口从对齐后的实际起点开始；保存导致前块长度变化后它不再是新版本规范起点。
  assert.equal(
    seedFilesLargeTextWindow(
      owner,
      largeWindowAt({
        path,
        offset: nominalStart + 2,
        version: "v1",
        totalBytes,
        content: "old",
      }),
    ),
    true,
  );

  const reads: FilesLargeTextWindowReadParams[] = [];
  const newTotalBytes = totalBytes + 7;
  const lease = acquireFilesLargeTextWindow({
    owner,
    initialTotalBytes: totalBytes,
    readWindow: async (params) => {
      reads.push(params);
      return largeWindowAt({
        path,
        offset: params.offset,
        version: "v2",
        totalBytes: newTotalBytes,
        content: "new-block",
      });
    },
  });
  try {
    store.getState().updateLargeTextBlock(
      large.id,
      {
        blockIndex,
        offset: nominalStart,
        deleteBytes: 3,
        originalText: "old",
        hasDecodingErrors: false,
      },
      "new",
    );
    const saving = saveOptions({
      store,
      buffer: store.getState().buffers[0]!,
      path,
      fileService: {
        readTextFileWindow: async () => windowOf(path, "", "v1", totalBytes),
        commitTextFile: async () => ({ path, version: "v2", totalBytes: newTotalBytes }),
      },
    });

    assert.equal(await saving.promise, true);
    await flushAsync();

    assert.equal(reads.length, 1);
    assert.equal(reads[0]?.offset, nominalStart);
    assert.equal(reads[0]?.expectedVersion, "v2");
    const snapshot = lease.getSnapshot();
    assert.equal(snapshot.phase, "ready");
    assert.equal(snapshot.window?.version, "v2");
    assert.equal(snapshot.block?.blockIndex, blockIndex);
    assert.equal(snapshot.block?.offset, nominalStart);
  } finally {
    lease.release();
  }
});

test("保存成功后展示读取失败仍保留提交结果，并以新基准重试", async () => {
  const path = "/work/large-reload-fail.log";
  const totalBytes = FILES_LARGE_TEXT_BLOCK_STEP * 3 + 100;
  const blockIndex = 2;
  const nominalStart = filesLargeTextNominalBlockStart(blockIndex);
  const store = createFilesEditorStore();
  const large = createLargeTextFileBuffer({ workspace, path, totalBytes });
  store.getState().openBuffer(large);
  store.getState().initializeLargeTextEdit(large.id, "v1", totalBytes);

  const owner = filesLargeTextWindowOwner(store.getState().buffers[0]! as never);
  assert.equal(
    seedFilesLargeTextWindow(
      owner,
      largeWindowAt({
        path,
        offset: nominalStart + 2,
        version: "v1",
        totalBytes,
        content: "old",
      }),
    ),
    true,
  );

  const reads: FilesLargeTextWindowReadParams[] = [];
  let offline = true;
  const lease = acquireFilesLargeTextWindow({
    owner,
    initialTotalBytes: totalBytes,
    readWindow: async (params) => {
      reads.push(params);
      if (offline) throw new Error("remote workspace offline");
      if (params.expectedVersion !== undefined && params.expectedVersion !== "v2") {
        throw Object.assign(new Error("changed"), { code: FILE_TEXT_WINDOW_CHANGED_CODE });
      }
      return largeWindowAt({
        path,
        offset: params.offset,
        version: "v2",
        totalBytes,
        content: "a",
      });
    },
  });
  try {
    // 模拟保存前 hook 仍把脏草稿基准 v1 同步给窗口；失败后不得继续钉住它。
    lease.setExpectedVersion("v1");
    store.getState().updateLargeTextBlock(
      large.id,
      {
        blockIndex,
        offset: nominalStart,
        deleteBytes: 3,
        originalText: "old",
        hasDecodingErrors: false,
      },
      "new",
    );
    const saving = saveOptions({
      store,
      buffer: store.getState().buffers[0]!,
      path,
      fileService: {
        readTextFileWindow: async () => windowOf(path, "", "v1", totalBytes),
        commitTextFile: async () => ({ path, version: "v2", totalBytes }),
      },
    });

    assert.equal(await saving.promise, true);
    await flushAsync();

    const current = store.getState().buffers[0]!;
    assert.ok(current.kind === "large-text");
    assert.equal(current.edit?.baseVersion, "v2");
    assert.deepEqual(current.edit?.changes, []);
    const failedSnapshot = lease.getSnapshot();
    assert.equal(failedSnapshot.window, null);
    assert.equal(failedSnapshot.phase, "error");
    assert.equal(failedSnapshot.error?.kind, "offline");

    offline = false;
    const retryStart = reads.length;
    lease.retry();
    await flushAsync();

    // 失败态没有块快照，重试仍应回到保存前正在查看的块，而不是退回第 0 块。
    assert.equal(reads[retryStart]?.offset, nominalStart);
    assert.equal(reads.at(-1)?.expectedVersion, "v2");
    assert.equal(lease.getSnapshot().phase, "ready");
    assert.equal(lease.getSnapshot().window?.version, "v2");
  } finally {
    lease.release();
  }
});

test("大文件另存为后旧 owner 窗口失效，新路径按新版本加载", async () => {
  const source = "/work/large-save-as-source.log";
  const target = "/work/large-save-as-target.log";
  const totalBytes = FILES_LARGE_TEXT_BLOCK_STEP * 2 + 50;
  const store = createFilesEditorStore();
  const large = createLargeTextFileBuffer({ workspace, path: source, totalBytes });
  store.getState().openBuffer(large);
  store.getState().initializeLargeTextEdit(large.id, "v1", totalBytes);

  const oldOwner = filesLargeTextWindowOwner(store.getState().buffers[0]! as never);
  assert.equal(
    seedFilesLargeTextWindow(
      oldOwner,
      largeWindowAt({ path: source, offset: 0, version: "v1", totalBytes, content: "old" }),
    ),
    true,
  );
  const oldLease = acquireFilesLargeTextWindow({
    owner: oldOwner,
    initialTotalBytes: totalBytes,
    readWindow: async () => {
      throw new Error("old owner should be invalidated");
    },
  });
  try {
    const saving = saveOptions({
      store,
      buffer: store.getState().buffers[0]!,
      path: target,
      targetVersion: null,
      fileService: {
        readTextFileWindow: async () =>
          largeWindowAt({ path: target, offset: 0, version: "target-v1", totalBytes }),
        commitTextFile: async () => ({
          path: target,
          version: "target-v1",
          totalBytes,
        }),
      },
    });

    assert.equal(await saving.promise, true);
    await flushAsync();

    const saved = store.getState().buffers[0]!;
    assert.equal(saved.path, target);
    assert.equal(oldLease.getSnapshot().window, null);
    assert.equal(oldLease.getSnapshot().block, null);

    const newOwner = filesLargeTextWindowOwner(saved as never);
    const newReads: FilesLargeTextWindowReadParams[] = [];
    const newLease = acquireFilesLargeTextWindow({
      owner: newOwner,
      initialTotalBytes: totalBytes,
      readWindow: async (params) => {
        newReads.push(params);
        return largeWindowAt({
          path: target,
          offset: params.offset,
          version: "target-v1",
          totalBytes,
          content: "target-block",
        });
      },
    });
    try {
      newLease.ensureLoaded();
      await flushAsync();
      assert.equal(newReads[0]?.path, target);
      assert.equal(newLease.getSnapshot().window?.path, target);
      assert.equal(newLease.getSnapshot().window?.version, "target-v1");
    } finally {
      newLease.release();
    }
  } finally {
    oldLease.release();
  }
});

test("保存后的重载会丢弃保存前迟到的旧窗口读取", async () => {
  const path = "/work/large-reload-late.log";
  const totalBytes = FILES_LARGE_TEXT_BLOCK_STEP * 2;
  const store = createFilesEditorStore();
  const large = createLargeTextFileBuffer({ workspace, path, totalBytes });
  store.getState().openBuffer(large);
  store.getState().initializeLargeTextEdit(large.id, "v1", totalBytes);
  store
    .getState()
    .updateLargeTextBlock(
      large.id,
      { blockIndex: 0, offset: 0, deleteBytes: 1, originalText: "a", hasDecodingErrors: false },
      "b",
    );

  const owner = filesLargeTextWindowOwner(store.getState().buffers[0]! as never);
  const pending: Array<{
    resolve: (window: FileTextWindow) => void;
    reject: (error: unknown) => void;
  }> = [];
  const lease = acquireFilesLargeTextWindow({
    owner,
    initialTotalBytes: totalBytes,
    readWindow: () =>
      new Promise<FileTextWindow>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  });
  try {
    lease.ensureLoaded();
    await flushAsync();
    assert.equal(pending.length, 1);

    const saving = saveOptions({
      store,
      buffer: store.getState().buffers[0]!,
      path,
      fileService: {
        // 旧实现从这里直接读并 seed，不推进请求序号。
        readTextFileWindow: async () =>
          largeWindowAt({ path, offset: 0, version: "v2", totalBytes, content: "new" }),
        commitTextFile: async () => ({ path, version: "v2", totalBytes }),
      },
    });
    assert.equal(await saving.promise, true);
    await flushAsync();
    assert.equal(pending.length, 2);

    // 保存前的旧请求此时才返回 v1：必须因请求序号失效而丢弃。
    pending[0]!.resolve(
      largeWindowAt({ path, offset: 0, version: "v1", totalBytes, content: "old" }),
    );
    await flushAsync();
    assert.notEqual(lease.getSnapshot().window?.version, "v1");

    pending[1]!.resolve(
      largeWindowAt({ path, offset: 0, version: "v2", totalBytes, content: "new" }),
    );
    await flushAsync();
    assert.equal(lease.getSnapshot().phase, "ready");
    assert.equal(lease.getSnapshot().window?.version, "v2");
  } finally {
    lease.release();
  }
});
