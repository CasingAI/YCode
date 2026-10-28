import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { packWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import {
  createWorkerWorkspaceFileSearchFilterBackend,
  type WorkspaceFileSearchFilterBackend,
} from "../src/workspace-file-search/workspaceFileSearchFilterBackend.js";

interface PostedFilterMessage {
  type: "filter";
  seq: number;
  query: string;
}

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: Array<Record<string, unknown>> = [];
  terminated = false;

  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitResult(seq: number, entries: WorkspaceFileEntry[]): void {
    this.onmessage?.({
      data: { type: "result", seq, entries },
    } as MessageEvent);
  }

  filterMessages(): PostedFilterMessage[] {
    return this.posted.filter(
      (message): message is PostedFilterMessage => message.type === "filter",
    ) as PostedFilterMessage[];
  }
}

function fileEntry(relativePath: string): WorkspaceFileEntry {
  return {
    path: `/ws/${relativePath}`,
    relativePath,
    name: relativePath.split("/").pop() ?? relativePath,
    type: "file",
  };
}

function withFakeWorker(run: (worker: FakeWorker) => Promise<void>): Promise<void> {
  const globals = globalThis as unknown as {
    document?: unknown;
    Worker?: unknown;
  };
  const previousDocument = globals.document;
  const previousWorker = globals.Worker;
  const worker = new FakeWorker();
  globals.document = {};
  globals.Worker = class {
    constructor() {
      return worker;
    }
  };
  return run(worker).finally(() => {
    if (previousDocument === undefined) {
      delete globals.document;
    } else {
      globals.document = previousDocument;
    }
    if (previousWorker === undefined) {
      delete globals.Worker;
    } else {
      globals.Worker = previousWorker;
    }
  });
}

test("过期 filter 结果真正丢弃：旧 scope 结果不能解析给新请求", async () => {
  await withFakeWorker(async (worker) => {
    const backend: WorkspaceFileSearchFilterBackend =
      createWorkerWorkspaceFileSearchFilterBackend();
    backend.setPacked("packed", "/ws");

    const oldRequest = backend.filter("old", { include: "*.ts" });
    const newRequest = backend.filter("new", { include: "*.js" });
    const [oldMessage, newMessage] = worker.filterMessages();
    assert.ok(oldMessage);
    assert.ok(newMessage);

    worker.emitResult(oldMessage.seq, [fileEntry("old.ts")]);
    // 旧 seq 的结果必须解析为 null，调用方不会把旧范围/旧索引结果当成新结果。
    assert.equal(await oldRequest, null);

    worker.emitResult(newMessage.seq, [fileEntry("new.js")]);
    assert.deepEqual(await newRequest, [fileEntry("new.js")]);

    backend.dispose();
    assert.equal(worker.terminated, true);
  });
});

test("索引重建会让在途 filter 过期（解析 null）", async () => {
  await withFakeWorker(async (worker) => {
    const backend = createWorkerWorkspaceFileSearchFilterBackend();
    backend.setPacked("packed-1", "/ws");
    const request = backend.filter("a", {});
    const [message] = worker.filterMessages();
    assert.ok(message);

    backend.setPacked("packed-2", "/ws");
    assert.equal(await request, null);

    // 迟到的旧结果不会再产生任何等待者。
    worker.emitResult(message.seq, [fileEntry("a.ts")]);
    backend.dispose();
  });
});

test("Worker 运行失败时切换到同步后端并返回实际匹配", async () => {
  await withFakeWorker(async (worker) => {
    const backend: WorkspaceFileSearchFilterBackend =
      createWorkerWorkspaceFileSearchFilterBackend();
    const entries = [fileEntry("a.ts"), fileEntry("b.js")];
    backend.setPacked(packWorkspaceFileEntries(entries), "/ws");

    const request = backend.filter("a", {});
    // 失败前不应先解析为空结果，否则父 hook 会把它当最终空结果且不再重试。
    worker.onerror?.({
      message: "boom",
    } as ErrorEvent);
    assert.deepEqual(await request, [entries[0]]);

    // 后续查询直接走同步降级，不再向已损坏的 Worker 发消息。
    const postsAfterFailure = worker.posted.length;
    assert.deepEqual(await backend.filter("b", {}), [entries[1]]);
    assert.equal(worker.posted.length, postsAfterFailure);

    // include/exclude/allowedPaths 规则在降级路径保持同一语义。
    assert.deepEqual(await backend.filter("", { include: "*.js" }), [entries[1]]);
    assert.deepEqual(await backend.filter("", { exclude: "*.ts" }), [entries[1]]);
    assert.deepEqual(await backend.filter("", { allowedPaths: ["/ws/a.ts"] }), [entries[0]]);
    assert.deepEqual(await backend.filter("", { allowedPaths: [] }), []);

    // 索引更新同步到降级后端。
    const updated = [fileEntry("c.md")];
    backend.setPacked(packWorkspaceFileEntries(updated), "/ws");
    assert.deepEqual(await backend.filter("", {}), updated);

    backend.dispose();
    assert.equal(worker.terminated, true);
  });
});

test("Worker 失败时旧请求 resolve null，最新请求用降级后端重算", async () => {
  await withFakeWorker(async (worker) => {
    const backend = createWorkerWorkspaceFileSearchFilterBackend();
    const entries = [fileEntry("a.ts"), fileEntry("b.js")];
    backend.setPacked(packWorkspaceFileEntries(entries), "/ws");

    const olderRequest = backend.filter("a", {});
    const latestRequest = backend.filter("", { include: "*.js" });
    worker.onerror?.({ message: "boom" } as ErrorEvent);

    assert.equal(await olderRequest, null);
    assert.deepEqual(await latestRequest, [entries[1]]);
    backend.dispose();
  });
});

test("降级后端沿用 Git 状态绝对路径 key（Windows 根路径）", async () => {
  await withFakeWorker(async (worker) => {
    const backend = createWorkerWorkspaceFileSearchFilterBackend();
    backend.setPacked(
      packWorkspaceFileEntries([fileEntry("src/app.ts"), fileEntry("b.js")]),
      "C:\\Repo",
    );
    const request = backend.filter("", {});
    worker.onerror?.({ message: "boom" } as ErrorEvent);
    await request;

    assert.deepEqual(await backend.filter("", { allowedPaths: ["C:\\Repo\\src\\app.ts"] }), [
      {
        name: "app.ts",
        path: "C:\\Repo\\src\\app.ts",
        relativePath: "src/app.ts",
        type: "file",
      },
    ]);
    backend.dispose();
  });
});
