import assert from "node:assert/strict";
import test from "node:test";
import { FILE_TEXT_WINDOW_MAX_BYTES } from "@zcode/shared";
import type { FileTextWindow } from "@zcode/shared";
import {
  acquireFilesLargeTextWindow,
  disposeFilesLargeTextWindow,
  seedFilesLargeTextWindow,
  type FilesLargeTextWindowOwner,
  type FilesLargeTextWindowReadParams,
} from "../src/files-workbench/filesLargeTextWindowStore.js";
import { resolveFilesLargeTextWatchDirectory } from "../src/files-workbench/filesLargeTextWindowTypes.js";

let serial = 0;
function owner(path = "/workspace/huge.log"): FilesLargeTextWindowOwner {
  serial += 1;
  return {
    bufferId: `large:lifecycle:${serial}`,
    workspaceKey: "workspace-a",
    remoteSessionId: "",
    path,
  };
}

function seededWindow(
  key: FilesLargeTextWindowOwner,
  overrides: Partial<FileTextWindow> = {},
): FileTextWindow {
  const totalBytes = overrides.totalBytes ?? 9 * 1024 * 1024;
  const content = overrides.content ?? "seeded-window";
  return {
    path: key.path,
    content,
    offset: 0,
    bytesRead: content.length,
    nextOffset: content.length,
    totalBytes,
    version: "v-seed",
    isBinary: false,
    eof: false,
    ...overrides,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("恢复 large：首窗已 seed 时 viewer 只补 totalBytes 元数据，不重读首窗", async () => {
  const key = owner("/workspace/restored-huge.log");
  const seeded = seededWindow(key, { totalBytes: 9 * 1024 * 1024 });
  assert.equal(seedFilesLargeTextWindow(key, seeded), true);

  let reads = 0;
  // 恢复时 core 尚未决策 totalBytes：hook 首次 acquire 拿不到提示。
  const lease = acquireFilesLargeTextWindow({
    owner: key,
    initialTotalBytes: undefined,
    readWindow: async (_params: FilesLargeTextWindowReadParams) => {
      reads += 1;
      throw new Error("seeded window should not be reread");
    },
  });
  try {
    // core 决策完成后 buffer.totalBytes 更新；viewer 只更新元数据，不能重新 acquire。
    lease.setInitialTotalBytes(seeded.totalBytes);
    lease.ensureLoaded();
    await flush();
    assert.equal(reads, 0);
    assert.equal(lease.getSnapshot().phase, "ready");
    assert.equal(lease.getSnapshot().window?.content, "seeded-window");
    assert.equal(lease.getSnapshot().window?.totalBytes, seeded.totalBytes);
  } finally {
    lease.release();
  }
});

test("dispose 后同一 owner 重新 seed：仍挂载的 lease 收到新窗口且不重读", async () => {
  const key = owner("/workspace/reload-huge.log");
  let reads = 0;
  const lease = acquireFilesLargeTextWindow({
    owner: key,
    initialTotalBytes: 9 * 1024 * 1024,
    readWindow: async (_params: FilesLargeTextWindowReadParams) => {
      reads += 1;
      throw new Error("reseeded window should not be reread");
    },
  });
  let notified = 0;
  const unsubscribe = lease.subscribe(() => {
    notified += 1;
  });
  try {
    lease.setActive(true);
    disposeFilesLargeTextWindow(key.bufferId, key);
    assert.equal(lease.getSnapshot().window, null);
    const afterDispose = notified;
    assert.ok(afterDispose >= 1, "dispose 应通知仍挂载的视图");

    // core 重新读取决策后在同一 owner 上 seed，旧 lease 必须重新绑定到新窗口。
    assert.equal(seedFilesLargeTextWindow(key, seededWindow(key, { content: "re-seeded" })), true);
    assert.ok(notified > afterDispose, "seed 应通知仍挂载的视图");
    assert.equal(lease.getSnapshot().phase, "ready");
    assert.equal(lease.getSnapshot().window?.content, "re-seeded");

    // 旧 lease 已重新绑定，ensureLoaded 不能额外读盘。
    lease.ensureLoaded();
    await flush();
    assert.equal(reads, 0);
    lease.navigate({ kind: "next" });
    assert.equal(reads, 1);
  } finally {
    unsubscribe();
    lease.release();
  }

  // 最后一个 lease 释放后 entry 不再保留旧窗口。
  const after = acquireFilesLargeTextWindow({
    owner: key,
    readWindow: async (params) => seededWindow(key, { offset: params.offset }),
  });
  try {
    assert.equal(after.getSnapshot().window, null);
  } finally {
    after.release();
  }
});

test("dispose 时没有挂载 lease 仍删除 entry，随后 seed 由新 viewer 直接复用", async () => {
  const key = owner("/workspace/unmounted-huge.log");
  const first = acquireFilesLargeTextWindow({
    owner: key,
    readWindow: async () => {
      throw new Error("no read");
    },
  });
  first.release();
  disposeFilesLargeTextWindow(key.bufferId, key);
  assert.equal(seedFilesLargeTextWindow(key, seededWindow(key, { content: "fresh-seed" })), true);

  let reads = 0;
  const lease = acquireFilesLargeTextWindow({
    owner: key,
    initialTotalBytes: 9 * 1024 * 1024,
    readWindow: async (_params: FilesLargeTextWindowReadParams) => {
      reads += 1;
      throw new Error("seeded window should not be reread");
    },
  });
  try {
    lease.ensureLoaded();
    await flush();
    assert.equal(reads, 0);
    assert.equal(lease.getSnapshot().window?.content, "fresh-seed");
  } finally {
    lease.release();
  }
});

test("大文件变化监视父目录：POSIX / Windows / 盘符根都解析到目录", () => {
  assert.equal(resolveFilesLargeTextWatchDirectory("/workspace/huge.log"), "/workspace");
  assert.equal(resolveFilesLargeTextWatchDirectory("C:\\workspace\\huge.log"), "C:\\workspace");
  assert.equal(resolveFilesLargeTextWatchDirectory("C:\\huge.log"), "C:\\");
  assert.equal(resolveFilesLargeTextWatchDirectory("/huge.log"), "/");
  assert.equal(resolveFilesLargeTextWatchDirectory("huge.log"), "huge.log");
});

test("窗口大小常量在测试假窗口内保持有界", () => {
  assert.ok(FILE_TEXT_WINDOW_MAX_BYTES > 0);
});
