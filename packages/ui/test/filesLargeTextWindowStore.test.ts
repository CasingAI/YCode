import assert from "node:assert/strict";
import test from "node:test";
import { FILE_TEXT_WINDOW_CHANGED_CODE, FILE_TEXT_WINDOW_MAX_BYTES } from "@zcode/shared";
import type { FileTextWindow, FileWatchEvent } from "@zcode/shared";
import {
  acquireFilesLargeTextWindow,
  disposeFilesLargeTextWindow,
  seedFilesLargeTextWindow,
  type FilesLargeTextWindowLease,
  type FilesLargeTextWindowReadParams,
  type FilesLargeTextWindowWatch,
} from "../src/files-workbench/filesLargeTextWindowStore.js";
import { FILES_LARGE_TEXT_BLOCK_STEP } from "../src/files-workbench/filesLargeTextBlockModel.js";
import { resolveFilesLargeTextExternalChange } from "../src/files-workbench/filesLargeTextWindowErrors.js";

const TOTAL = 8 * 1024 * 1024 * 1024; // 8 GiB

let serial = 0;
function owner(path = "/workspace/huge.log") {
  serial += 1;
  return {
    bufferId: `large:test:${serial}`,
    workspaceKey: "workspace-a",
    remoteSessionId: "",
    path,
  };
}

function windowFor(
  params: FilesLargeTextWindowReadParams,
  overrides: Partial<FileTextWindow> = {},
): FileTextWindow {
  const offset = overrides.offset ?? params.offset;
  const totalBytes = overrides.totalBytes ?? TOTAL;
  const nextOffset = Math.min(
    overrides.nextOffset ?? offset + FILE_TEXT_WINDOW_MAX_BYTES,
    totalBytes,
  );
  return {
    path: params.path,
    content: `chunk@${offset}`,
    offset,
    bytesRead: nextOffset - offset,
    nextOffset,
    totalBytes,
    version: "v1",
    isBinary: false,
    eof: nextOffset >= totalBytes,
    ...overrides,
  };
}

function deferredReader() {
  const requests: Array<{
    params: FilesLargeTextWindowReadParams;
    resolve: (window: FileTextWindow) => void;
    reject: (error: unknown) => void;
  }> = [];
  return {
    requests,
    read: (params: FilesLargeTextWindowReadParams) =>
      new Promise<FileTextWindow>((resolve, reject) => {
        requests.push({ params, resolve, reject });
      }),
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function releaseAll(leases: FilesLargeTextWindowLease[]): void {
  for (const lease of leases) lease.release();
}

test("首次读取 offset=0 且不带版本；下一段使用精确 nextOffset 并带当前版本", async () => {
  const key = owner();
  const calls: FilesLargeTextWindowReadParams[] = [];
  const lease = acquireFilesLargeTextWindow({
    owner: key,
    readWindow: async (params) => {
      calls.push(params);
      return windowFor(params, { totalBytes: 1_000_000 });
    },
  });
  try {
    lease.ensureLoaded();
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.offset, 0);
    assert.equal(calls[0]?.expectedVersion, undefined);
    assert.equal(lease.getSnapshot().window?.offset, 0);
    assert.equal(lease.getSnapshot().phase, "ready");

    lease.navigate({ kind: "next" });
    await flush();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.offset, FILES_LARGE_TEXT_BLOCK_STEP);
    assert.equal(calls[1]?.expectedVersion, "v1");
    assert.equal(lease.getSnapshot().window?.offset, FILES_LARGE_TEXT_BLOCK_STEP);
    assert.equal(lease.getSnapshot().block?.blockIndex, 1);
    assert.equal(lease.getSnapshot().revision, 2);
  } finally {
    lease.release();
  }
});

test("首窗 previous 与 EOF 后 next 均不发请求", async () => {
  const key = owner();
  const calls: FilesLargeTextWindowReadParams[] = [];
  const lease = acquireFilesLargeTextWindow({
    owner: key,
    readWindow: async (params) => {
      calls.push(params);
      return windowFor(params, { totalBytes: 600_000 });
    },
  });
  try {
    lease.ensureLoaded();
    await flush();
    assert.equal(calls.length, 1);

    lease.navigate({ kind: "previous" });
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(lease.getSnapshot().window?.offset, 0);

    lease.navigate({ kind: "next" });
    await flush();
    assert.equal(calls.length, 2);
    lease.navigate({ kind: "next" });
    await flush();
    assert.equal(calls.length, 3);
    assert.equal(lease.getSnapshot().window?.eof, true);
    assert.equal(lease.getSnapshot().window?.offset, 2 * FILES_LARGE_TEXT_BLOCK_STEP);

    // 最后一块继续向后是空操作，不能重复读取或请求空窗。
    lease.navigate({ kind: "next" });
    await flush();
    assert.equal(calls.length, 3);
    assert.equal(lease.getSnapshot().window?.offset, 2 * FILES_LARGE_TEXT_BLOCK_STEP);
  } finally {
    lease.release();
  }
});

test("seed 首窗不重复读盘，首次 acquire 直接复用；已有窗口时拒绝覆盖", async () => {
  const key = owner();
  const seeded: FileTextWindow = {
    path: key.path,
    content: "seeded-window",
    offset: 0,
    bytesRead: 14,
    nextOffset: 14,
    totalBytes: 500_000,
    version: "v-seed",
    isBinary: false,
    eof: false,
  };
  assert.equal(seedFilesLargeTextWindow(key, seeded), true);
  // 重复 seed 不能替换已注入首窗。
  assert.equal(seedFilesLargeTextWindow(key, { ...seeded, content: "other" }), false);

  const calls: FilesLargeTextWindowReadParams[] = [];
  const lease = acquireFilesLargeTextWindow({
    owner: key,
    readWindow: async (params) => {
      calls.push(params);
      return windowFor(params);
    },
  });
  try {
    lease.ensureLoaded();
    await flush();
    assert.equal(calls.length, 0);
    assert.equal(lease.getSnapshot().phase, "ready");
    assert.equal(lease.getSnapshot().window?.content, "seeded-window");
    assert.equal(lease.getSnapshot().window?.version, "v-seed");

    assert.equal(seedFilesLargeTextWindow(key, { ...seeded, content: "late" }), false);
    lease.navigate({ kind: "next" });
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.offset, FILES_LARGE_TEXT_BLOCK_STEP);
    assert.equal(calls[0]?.expectedVersion, "v-seed");
  } finally {
    lease.release();
  }
  // seed 的正文在最后一个订阅者释放后不被保留。
  const reloadCalls: FilesLargeTextWindowReadParams[] = [];
  const reloaded = acquireFilesLargeTextWindow({
    owner: key,
    readWindow: async (params) => {
      reloadCalls.push(params);
      return windowFor(params);
    },
  });
  try {
    assert.equal(reloaded.getSnapshot().window, null);
    reloaded.ensureLoaded();
    await flush();
    assert.equal(reloadCalls.length, 1);
  } finally {
    reloaded.release();
  }
});

test("同 ID 换 owner 后 seed，旧租约释放不能删除新窗口", () => {
  const bufferId = `large:seed-reuse:${++serial}`;
  const ownerA = {
    bufferId,
    workspaceKey: "workspace-a",
    remoteSessionId: "",
    path: "/workspace/a/huge.log",
  };
  const ownerB = {
    bufferId,
    workspaceKey: "workspace-b",
    remoteSessionId: "",
    path: "/workspace/b/huge.log",
  };
  const first = acquireFilesLargeTextWindow({
    owner: ownerA,
    readWindow: async (params) => windowFor(params),
  });
  const seeded: FileTextWindow = {
    path: ownerB.path,
    content: "b-seed",
    offset: 0,
    bytesRead: 6,
    nextOffset: 6,
    totalBytes: 900_000,
    version: "v-b",
    isBinary: false,
    eof: false,
  };
  try {
    assert.equal(seedFilesLargeTextWindow(ownerB, seeded), true);
    first.release();
    const second = acquireFilesLargeTextWindow({
      owner: ownerB,
      readWindow: async (params) => windowFor(params),
    });
    try {
      assert.equal(second.getSnapshot().window?.content, "b-seed");
    } finally {
      second.release();
    }
  } finally {
    first.release();
    disposeFilesLargeTextWindow(bufferId);
  }
});

test("同 buffer 多 split 只启动一个 watcher；变化只标 stale 不替换窗口", async () => {
  const key = owner();
  let starts = 0;
  let stops = 0;
  let emit: ((event: FileWatchEvent) => void) | null = null;
  const watch: FilesLargeTextWindowWatch = (onChange) => {
    starts += 1;
    emit = onChange;
    return () => {
      stops += 1;
    };
  };
  const read = async (params: FilesLargeTextWindowReadParams) =>
    windowFor(params, { totalBytes: 2_000_000 });
  const first = acquireFilesLargeTextWindow({ owner: key, readWindow: read, watch });
  const second = acquireFilesLargeTextWindow({ owner: key, readWindow: read, watch });
  try {
    first.setActive(true);
    second.setActive(true);
    assert.equal(starts, 1);

    first.ensureLoaded();
    await flush();
    const revision = first.getSnapshot().revision;
    assert.equal(first.getSnapshot().stale, false);

    // 其他路径的事件不影响当前窗口。
    emit!({ dirPath: "/workspace", changedPath: "/workspace/other.log" });
    assert.equal(first.getSnapshot().stale, false);

    emit!({ dirPath: "/workspace", changedPath: key.path });
    assert.equal(first.getSnapshot().stale, true);
    assert.equal(first.getSnapshot().error?.kind, "changed");
    assert.equal(first.getSnapshot().window?.content, "chunk@0");
    assert.equal(first.getSnapshot().revision, revision);
    assert.equal(second.getSnapshot().stale, true);

    first.setActive(false);
    assert.equal(stops, 0);
    second.setActive(false);
    assert.equal(stops, 1);
  } finally {
    releaseAll([first, second]);
  }
  assert.equal(stops, 1);
});

test("读取期间文件变化：结果不覆盖旧窗口，只保留刷新提示", async () => {
  const key = owner();
  const reader = deferredReader();
  let emit: ((event: FileWatchEvent) => void) | null = null;
  const lease = acquireFilesLargeTextWindow({
    owner: key,
    readWindow: reader.read,
    watch: (onChange) => {
      emit = onChange;
      return () => {};
    },
  });
  try {
    lease.setActive(true);
    lease.ensureLoaded();
    reader.requests[0]!.resolve(windowFor(reader.requests[0]!.params));
    await flush();
    assert.equal(lease.getSnapshot().window?.offset, 0);

    lease.navigate({ kind: "offset", offset: 2 * FILES_LARGE_TEXT_BLOCK_STEP + 1000 });
    assert.equal(reader.requests.length, 2);
    emit!({ dirPath: "/workspace", changedPath: key.path });
    reader.requests[1]!.resolve(
      windowFor(reader.requests[1]!.params, { content: "new-version-window" }),
    );
    await flush();
    assert.equal(lease.getSnapshot().window?.offset, 0);
    assert.equal(lease.getSnapshot().window?.content, "chunk@0");
    assert.equal(lease.getSnapshot().stale, true);
    assert.equal(lease.getSnapshot().error?.kind, "changed");
  } finally {
    lease.setActive(false);
    lease.release();
  }
});

test("刷新遇到文件缩短时把越界块夹紧到最后一块", async () => {
  const key = owner();
  const reader = deferredReader();
  const lease = acquireFilesLargeTextWindow({ owner: key, readWindow: reader.read });
  try {
    lease.ensureLoaded();
    reader.requests[0]!.resolve(windowFor(reader.requests[0]!.params, { totalBytes: 1_000_000 }));
    await flush();

    // block 3：文件缩短后该索引已越界。
    lease.navigate({ kind: "offset", offset: 900_000 });
    reader.requests[1]!.resolve(
      windowFor(reader.requests[1]!.params, {
        offset: 3 * FILES_LARGE_TEXT_BLOCK_STEP,
        totalBytes: 1_000_000,
      }),
    );
    await flush();
    assert.equal(lease.getSnapshot().block?.blockIndex, 3);

    lease.refresh();
    const refreshParams = reader.requests[2]!.params;
    assert.equal(refreshParams.offset, 3 * FILES_LARGE_TEXT_BLOCK_STEP);
    reader.requests[2]!.resolve({
      path: key.path,
      content: "",
      offset: refreshParams.offset,
      bytesRead: 0,
      nextOffset: 300_000,
      totalBytes: 300_000,
      version: "v2",
      isBinary: false,
      eof: true,
    });
    await flush();

    // 只追加一次尾部块夹紧请求，不循环重读。
    assert.equal(reader.requests.length, 4);
    const clampParams = reader.requests[3]!.params;
    assert.equal(clampParams.offset, FILES_LARGE_TEXT_BLOCK_STEP);
    reader.requests[3]!.resolve(
      windowFor(clampParams, {
        offset: clampParams.offset,
        totalBytes: 300_000,
        version: "v2",
      }),
    );
    await flush();
    assert.equal(lease.getSnapshot().block?.blockIndex, 1);
    assert.equal(lease.getSnapshot().window?.version, "v2");
    assert.equal(lease.getSnapshot().stale, false);
    assert.equal(reader.requests.length, 4);
  } finally {
    lease.release();
  }
});

test("同一 buffer 的多个分屏共享唯一窗口与请求序号", async () => {
  const key = owner();
  const calls: FilesLargeTextWindowReadParams[] = [];
  const read = async (params: FilesLargeTextWindowReadParams) => {
    calls.push(params);
    return windowFor(params, { totalBytes: 1_000_000 });
  };
  const first = acquireFilesLargeTextWindow({ owner: key, readWindow: read });
  const second = acquireFilesLargeTextWindow({ owner: key, readWindow: read });
  try {
    first.ensureLoaded();
    await flush();
    assert.equal(second.getSnapshot().window?.offset, 0);

    second.navigate({ kind: "offset", offset: 500_000 });
    await flush();
    assert.equal(calls.length, 2);
    assert.equal(first.getSnapshot().window?.offset, FILES_LARGE_TEXT_BLOCK_STEP);
    assert.equal(first.getSnapshot().block?.blockIndex, 1);
    assert.equal(second.getSnapshot().window?.version, "v1");
  } finally {
    releaseAll([first, second]);
  }
});

test("迟到结果不能覆盖更新的导航请求", async () => {
  const key = owner();
  const reader = deferredReader();
  const lease = acquireFilesLargeTextWindow({ owner: key, readWindow: reader.read });
  try {
    lease.ensureLoaded();
    reader.requests[0]!.resolve(windowFor(reader.requests[0]!.params));
    await flush();
    assert.equal(lease.getSnapshot().window?.offset, 0);

    lease.navigate({ kind: "offset", offset: FILES_LARGE_TEXT_BLOCK_STEP + 1000 });
    lease.navigate({ kind: "offset", offset: 2 * FILES_LARGE_TEXT_BLOCK_STEP + 1000 });
    assert.equal(reader.requests.length, 3);

    reader.requests[2]!.resolve(windowFor(reader.requests[2]!.params));
    await flush();
    assert.equal(lease.getSnapshot().block?.blockIndex, 2);

    // 旧请求即使更晚返回也不能替换新窗口。
    reader.requests[1]!.resolve(windowFor(reader.requests[1]!.params));
    await flush();
    assert.equal(lease.getSnapshot().block?.blockIndex, 2);
    assert.equal(lease.getSnapshot().pendingOffset, null);
  } finally {
    lease.release();
  }
});

test("版本变化保留旧窗口并提示刷新；刷新不传版本并替换版本", async () => {
  const key = owner();
  const reader = deferredReader();
  const lease = acquireFilesLargeTextWindow({ owner: key, readWindow: reader.read });
  try {
    lease.ensureLoaded();
    reader.requests[0]!.resolve(windowFor(reader.requests[0]!.params));
    await flush();

    lease.navigate({ kind: "offset", offset: FILES_LARGE_TEXT_BLOCK_STEP + 4096 });
    reader.requests[1]!.reject({ code: FILE_TEXT_WINDOW_CHANGED_CODE });
    await flush();
    assert.equal(lease.getSnapshot().window?.offset, 0);
    assert.equal(lease.getSnapshot().stale, true);
    assert.equal(lease.getSnapshot().error?.kind, "changed");
    assert.equal(lease.getSnapshot().phase, "ready");

    lease.refresh();
    const refreshParams = reader.requests[2]!.params;
    assert.equal(refreshParams.offset, 0);
    assert.equal(refreshParams.expectedVersion, undefined);
    reader.requests[2]!.resolve(windowFor(refreshParams, { version: "v2" }));
    await flush();
    assert.equal(lease.getSnapshot().window?.version, "v2");
    assert.equal(lease.getSnapshot().stale, false);
    assert.equal(lease.getSnapshot().error, null);
  } finally {
    lease.release();
  }
});

test("重复点击同一 pending 位置只发一次请求；同位置已加载时不重复请求", async () => {
  const key = owner();
  const calls: FilesLargeTextWindowReadParams[] = [];
  const lease = acquireFilesLargeTextWindow({
    owner: key,
    readWindow: async (params) => {
      calls.push(params);
      return windowFor(params);
    },
  });
  try {
    lease.ensureLoaded();
    await flush();
    lease.navigate({ kind: "offset", offset: FILES_LARGE_TEXT_BLOCK_STEP + 10_000 });
    lease.navigate({ kind: "offset", offset: FILES_LARGE_TEXT_BLOCK_STEP + 10_000 });
    await flush();
    assert.equal(calls.length, 2);
    lease.navigate({ kind: "offset", offset: FILES_LARGE_TEXT_BLOCK_STEP + 10_000 });
    assert.equal(calls.length, 2);
  } finally {
    lease.release();
  }
});

test("二进制结果不会替换已有文本窗口", async () => {
  const key = owner();
  const reader = deferredReader();
  const lease = acquireFilesLargeTextWindow({ owner: key, readWindow: reader.read });
  try {
    lease.ensureLoaded();
    reader.requests[0]!.resolve(windowFor(reader.requests[0]!.params));
    await flush();

    lease.navigate({ kind: "offset", offset: FILES_LARGE_TEXT_BLOCK_STEP + 2048 });
    reader.requests[1]!.resolve(
      windowFor(reader.requests[1]!.params, { content: "", isBinary: true }),
    );
    await flush();
    assert.equal(lease.getSnapshot().window?.offset, 0);
    assert.equal(lease.getSnapshot().error?.kind, "binary");
  } finally {
    lease.release();
  }
});

test("首次读取即二进制时不建立文本窗口", async () => {
  const key = owner();
  const lease = acquireFilesLargeTextWindow({
    owner: key,
    readWindow: async (params) => windowFor(params, { content: "", isBinary: true }),
  });
  try {
    lease.ensureLoaded();
    await flush();
    assert.equal(lease.getSnapshot().window, null);
    assert.equal(lease.getSnapshot().phase, "error");
    assert.equal(lease.getSnapshot().error?.kind, "binary");
  } finally {
    lease.release();
  }
});

test("初次窗口含非法字节时用严格本块范围复核，合法块恢复可编辑", async () => {
  const key = owner();
  const calls: FilesLargeTextWindowReadParams[] = [];
  const lease = acquireFilesLargeTextWindow({
    owner: key,
    readWindow: async (params) => {
      calls.push(params);
      if (calls.length === 1) {
        return windowFor(params, { content: "abc\uFFFDe", hasDecodingErrors: true });
      }
      return windowFor(params, { content: "abc", hasDecodingErrors: false });
    },
  });
  try {
    lease.ensureLoaded();
    await flush();
    assert.equal(calls.length, 3);
    // 先对 nominalEnd 做最小 4 字节 probe 得到真实结束位置。
    assert.equal(calls[1]?.offset, FILES_LARGE_TEXT_BLOCK_STEP);
    assert.equal(calls[1]?.length, 4);
    assert.equal(calls[1]?.expectedVersion, "v1");
    // 精确复核严格限制在本块，不能额外 +4 字节。
    assert.equal(calls[2]?.offset, 0);
    assert.equal(calls[2]?.length, FILES_LARGE_TEXT_BLOCK_STEP);
    assert.equal(calls[2]?.expectedVersion, "v1");
    assert.equal(lease.getSnapshot().block?.hasDecodingErrors, false);
    assert.equal(lease.getSnapshot().block?.needsExactConfirmation, false);
    assert.equal(lease.getSnapshot().block?.content, "abc");
  } finally {
    lease.release();
  }
});

test("脏草稿导航与刷新都带 baseVersion；版本冲突保留旧块只提示", async () => {
  const key = owner();
  const reader = deferredReader();
  const lease = acquireFilesLargeTextWindow({ owner: key, readWindow: reader.read });
  try {
    lease.ensureLoaded();
    reader.requests[0]!.resolve(windowFor(reader.requests[0]!.params, { version: "v-base" }));
    await flush();
    lease.setExpectedVersion("v-base");

    lease.navigate({ kind: "next" });
    assert.equal(reader.requests[1]?.params.expectedVersion, "v-base");
    reader.requests[1]!.resolve(
      windowFor(reader.requests[1]!.params, { version: "v-base" }),
    );
    await flush();

    lease.refresh();
    assert.equal(reader.requests[2]?.params.expectedVersion, "v-base");
    reader.requests[2]!.reject({ code: FILE_TEXT_WINDOW_CHANGED_CODE });
    await flush();
    assert.equal(lease.getSnapshot().block?.blockIndex, 1);
    assert.equal(lease.getSnapshot().stale, true);
    assert.equal(lease.getSnapshot().error?.kind, "changed");
  } finally {
    lease.release();
  }
});

test("有界探针只标外部变化，不替换脏窗口或重设基准", async () => {
  const key = owner();
  const reader = deferredReader();
  const lease = acquireFilesLargeTextWindow({ owner: key, readWindow: reader.read });
  try {
    lease.ensureLoaded();
    reader.requests[0]!.resolve(windowFor(reader.requests[0]!.params, { version: "v-base" }));
    await flush();
    lease.setExpectedVersion("v-base");

    lease.probeExternalChange();
    assert.equal(reader.requests.length, 2);
    const probe = reader.requests[1]!.params;
    assert.equal(probe.length, 4);
    assert.equal(probe.offset, 0);
    // 探针不带 expectedVersion，才能区分 ENOENT / 新版本。
    assert.equal(probe.expectedVersion, undefined);
    reader.requests[1]!.resolve(
      windowFor(probe, { version: "v-disk", totalBytes: 1_000_000 }),
    );
    await flush();

    const snapshot = lease.getSnapshot();
    assert.equal(snapshot.window?.version, "v-base");
    assert.equal(snapshot.block?.blockIndex, 0);
    assert.equal(snapshot.stale, true);
    assert.equal(snapshot.observedVersion, "v-disk");
    assert.deepEqual(resolveFilesLargeTextExternalChange(snapshot), {
      kind: "changed",
      observedVersion: "v-disk",
    });
  } finally {
    lease.release();
  }
});

test("探针遇到 ENOENT 映射为 deleted；普通读取失败不冒充外部变化", async () => {
  const key = owner();
  const reader = deferredReader();
  const lease = acquireFilesLargeTextWindow({ owner: key, readWindow: reader.read });
  try {
    lease.ensureLoaded();
    reader.requests[0]!.resolve(windowFor(reader.requests[0]!.params));
    await flush();

    lease.probeExternalChange();
    reader.requests[1]!.reject({ code: "ENOENT" });
    await flush();
    assert.equal(lease.getSnapshot().error?.kind, "deleted");
    assert.equal(lease.getSnapshot().observedVersion, null);
    assert.equal(lease.getSnapshot().block?.blockIndex, 0);
    assert.deepEqual(resolveFilesLargeTextExternalChange(lease.getSnapshot()), {
      kind: "deleted",
      observedVersion: null,
    });

    lease.probeExternalChange();
    reader.requests[2]!.reject({ code: "EACCES" });
    await flush();
    // 非删除 / 非版本错误保持已有提示，不清空也不新增。
    assert.equal(lease.getSnapshot().error?.kind, "deleted");
  } finally {
    lease.release();
  }
});

test("缓冲 ID 复用但路径 / 工作区变化时旧请求作废，不串结果", async () => {
  const bufferId = `large:reuse:${++serial}`;
  const reader = deferredReader();
  const ownerA = {
    bufferId,
    workspaceKey: "workspace-a",
    remoteSessionId: "remote-1",
    path: "/workspace/a/huge.log",
  };
  const ownerB = {
    bufferId,
    workspaceKey: "workspace-b",
    remoteSessionId: "remote-2",
    path: "/workspace/b/huge.log",
  };
  const first = acquireFilesLargeTextWindow({ owner: ownerA, readWindow: reader.read });
  first.ensureLoaded();
  assert.equal(reader.requests[0]?.params.path, ownerA.path);

  const second = acquireFilesLargeTextWindow({ owner: ownerB, readWindow: reader.read });
  try {
    second.ensureLoaded();
    assert.equal(reader.requests[1]?.params.path, ownerB.path);
    assert.equal(reader.requests[1]?.params.offset, 0);

    // 旧 generation 的迟到结果直接丢弃。
    reader.requests[0]!.resolve(windowFor(reader.requests[0]!.params));
    await flush();
    assert.equal(second.getSnapshot().window, null);

    reader.requests[1]!.resolve(windowFor(reader.requests[1]!.params));
    await flush();
    assert.equal(second.getSnapshot().window?.path, ownerB.path);

    first.release();
    assert.equal(second.getSnapshot().window?.path, ownerB.path);
    second.release();
    assert.equal(first.getSnapshot().window, null);
  } finally {
    first.release();
    second.release();
    disposeFilesLargeTextWindow(bufferId);
  }
});

test("订阅者归零释放窗口；再次激活重新从零读取", async () => {
  const key = owner();
  const first = acquireFilesLargeTextWindow({
    owner: key,
    readWindow: async (params) => windowFor(params),
  });
  first.ensureLoaded();
  await flush();
  assert.equal(first.getSnapshot().window?.offset, 0);
  first.release();

  const calls: FilesLargeTextWindowReadParams[] = [];
  const second = acquireFilesLargeTextWindow({
    owner: key,
    readWindow: async (params) => {
      calls.push(params);
      return windowFor(params);
    },
  });
  try {
    assert.equal(second.getSnapshot().window, null);
    assert.equal(second.getSnapshot().phase, "idle");
    second.ensureLoaded();
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(second.getSnapshot().window?.offset, 0);
  } finally {
    second.release();
  }
});
