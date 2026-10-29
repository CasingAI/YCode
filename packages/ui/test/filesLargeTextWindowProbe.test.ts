import assert from "node:assert/strict";
import test from "node:test";
import type { FileTextWindow, FileWatchEvent } from "@zcode/shared";
import {
  acquireFilesLargeTextWindow,
  disposeFilesLargeTextWindow,
  seedFilesLargeTextWindow,
  type FilesLargeTextWindowReadParams,
} from "../src/files-workbench/filesLargeTextWindowStore.js";
import { resolveFilesLargeTextExternalChange } from "../src/files-workbench/filesLargeTextWindowErrors.js";

let serial = 0;
function setup(watch?: (onChange: (event: FileWatchEvent) => void) => () => void) {
  const owner = {
    bufferId: `probe:${++serial}`,
    path: "/work/large.log",
    workspaceKey: "work",
    remoteSessionId: "",
  };
  const requests: Array<{
    params: FilesLargeTextWindowReadParams;
    resolve: (value: FileTextWindow) => void;
    reject: (error: unknown) => void;
  }> = [];
  const window = (version: string, isBinary = false): FileTextWindow => ({
    path: owner.path,
    content: "old",
    offset: 0,
    bytesRead: 3,
    nextOffset: 3,
    totalBytes: 9 * 1024 * 1024,
    version,
    isBinary,
    eof: false,
  });
  seedFilesLargeTextWindow(owner, window("v1"));
  const lease = acquireFilesLargeTextWindow({
    owner,
    watch,
    readWindow: (params) =>
      new Promise((resolve, reject) => requests.push({ params, resolve, reject })),
  });
  return { owner, requests, window, lease };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("同一窗口的并发焦点与多分屏探测合并为一个请求", async () => {
  const { lease, requests, window } = setup();
  try {
    lease.setActive(true);
    lease.probeExternalChange();
    lease.probeExternalChange();
    assert.equal(requests.length, 1);
    requests[0]!.resolve(window("v2"));
    await flush();
    assert.equal(lease.getSnapshot().observedVersion, "v2");
    assert.equal(lease.getSnapshot().window?.version, "v1");
  } finally {
    lease.release();
  }
});

for (const outcome of ["changed", "deleted"] as const) {
  test(`保存重载后的新窗口不接受旧探测的 ${outcome} 结果`, async () => {
    const { owner, lease, requests, window } = setup();
    try {
      lease.setActive(true);
      lease.probeExternalChange();
      const old = requests[0]!;
      disposeFilesLargeTextWindow(owner.bufferId, owner);
      seedFilesLargeTextWindow(owner, window("saved-v3"));
      if (outcome === "changed") old.resolve(window("v2"));
      else old.reject({ code: "ENOENT" });
      await flush();
      assert.equal(lease.getSnapshot().window?.version, "saved-v3");
      assert.equal(lease.getSnapshot().stale, false);
      assert.equal(lease.getSnapshot().error, null);
    } finally {
      lease.release();
    }
  });
}

test("全部分屏隐藏后迟到的探测不写状态，重新激活可再次探测", async () => {
  const { lease, requests, window } = setup();
  try {
    lease.setActive(true);
    lease.probeExternalChange();
    lease.setActive(false);
    requests[0]!.resolve(window("v2"));
    await flush();
    assert.equal(lease.getSnapshot().stale, false);
    lease.setActive(true);
    lease.probeExternalChange();
    assert.equal(requests.length, 2);
    requests[1]!.resolve(window("v3"));
    await flush();
    assert.equal(lease.getSnapshot().observedVersion, "v3");
  } finally {
    lease.release();
  }
});

test("探测文件已变二进制时只提示变化，不丢弃旧正文", async () => {
  const { lease, requests, window } = setup();
  try {
    lease.setActive(true);
    lease.probeExternalChange();
    requests[0]!.resolve(window("v2", true));
    await flush();
    assert.equal(lease.getSnapshot().error?.kind, "binary");
    assert.deepEqual(resolveFilesLargeTextExternalChange(lease.getSnapshot()), {
      kind: "changed",
      observedVersion: "v2",
    });
    assert.equal(lease.getSnapshot().window?.content, "old");
  } finally {
    lease.release();
  }
});

test("目录事件以有界探测区分删除，多个事件不重复启动在途探测", async () => {
  let emit: ((event: FileWatchEvent) => void) | undefined;
  const { lease, requests, window, owner } = setup((onChange) => {
    emit = onChange;
    return () => {};
  });
  try {
    lease.setActive(true);
    // 激活探测如果已发起，先结束它，避免混淆目录事件。
    if (requests.length > 0) {
      requests[0]!.resolve(window("v1"));
      await flush();
    }
    const before = requests.length;
    emit?.({ dirPath: "/work", changedPath: owner.path });
    emit?.({ dirPath: "/work", changedPath: owner.path });
    assert.equal(requests.length, before + 1);
    requests.at(-1)!.reject({ code: "ENOENT" });
    await flush();
    assert.equal(lease.getSnapshot().error?.kind, "deleted");
  } finally {
    lease.release();
  }
});
