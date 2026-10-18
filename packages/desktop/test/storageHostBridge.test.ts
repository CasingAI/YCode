import assert from "node:assert/strict";
import test from "node:test";
import { Emitter } from "@zcode/rpc";
import {
  storageHostRequestSchema,
  storageHostResultSchema,
  storageHostProgressSchema,
  type StorageUsageSnapshot,
} from "@zcode/shared";
import type { IStorageService } from "@zcode/services";
import { createStorageRpcScope } from "@zcode/services/node";
import { createStorageMainBridge } from "../src/host/storageMainBridge.js";
import { createStorageHostRelay } from "../src/main/storageHostRelay.js";

test("Main 与 Window Host 双向转发扫描、订阅、快照、清理和关联应答", async () => {
  const progress = new Emitter<StorageUsageSnapshot>();
  let current = 0;
  let snapshot: StorageUsageSnapshot | null = null;
  const cancelled: string[] = [];
  const owner: IStorageService = {
    async startScan() {
      const jobId = `job-${++current}`;
      snapshot = {
        jobId,
        status: "complete",
        startedAt: 1,
        finishedAt: 2,
        roots: [],
        errors: [],
      };
      // 终态早于 startScan 返回：真实 IPC 和 RPC 都可能如此。
      progress.fire(snapshot);
      return { jobId };
    },
    async cancelScan(jobId) {
      cancelled.push(jobId);
    },
    async getSnapshot() {
      return snapshot;
    },
    async clean() {
      return { deletedCount: 3, skippedCount: 0, failures: [] };
    },
    onScanProgress: progress.event,
    dispose() {
      progress.dispose();
    },
  };
  const received: StorageUsageSnapshot[] = [];
  let relay: ReturnType<typeof createStorageHostRelay>;
  const bridge = createStorageMainBridge((message) => {
    storageHostRequestSchema.parse(message);
    void relay.handle(message);
  });
  relay = createStorageHostRelay(owner, (message) => {
    if (message.type === "storage-progress") {
      storageHostProgressSchema.parse(message);
      bridge.handleProgress(message.snapshot);
    } else {
      storageHostResultSchema.parse(message);
      bridge.handleResult(message);
    }
  });
  const unsubscribe = bridge.service.onScanProgress((value) =>
    received.push(value),
  );
  const attachmentA = createStorageRpcScope(bridge.service);
  const attachmentB = createStorageRpcScope(bridge.service);
  try {
    assert.equal((await attachmentA.service.startScan()).jobId, "job-1");
    assert.deepEqual(
      received.map((item) => item.jobId),
      ["job-1"],
    );
    assert.equal((await attachmentA.service.getSnapshot())?.status, "complete");
    assert.equal(
      (
        await attachmentA.service.clean({
          rootId: "home",
          categoryIds: ["temporaryCaches"],
          ageRange: "all",
        })
      ).deletedCount,
      3,
    );
    assert.equal((await attachmentB.service.startScan()).jobId, "job-2");
    attachmentA.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Main 只取消当前扫描；旧 job 已被第二次扫描取代，旧 attachment 不得取消它。
    assert.deepEqual(cancelled, []);
    assert.equal((await attachmentB.service.getSnapshot())?.jobId, "job-2");
    attachmentB.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(cancelled, ["job-2"]);
  } finally {
    unsubscribe.dispose();
    bridge.service.dispose();
    relay.dispose();
    owner.dispose();
  }
});

test("严格消息契约拒绝任意路径与不允许的清理类别输入", () => {
  const parse = (request: unknown) =>
    storageHostRequestSchema.safeParse({
      type: "storage-request",
      requestId: "r1",
      command: { method: "clean", request },
    }).success;
  assert.equal(
    parse({ rootId: "home", categoryIds: ["logs"], ageRange: "all" }),
    true,
  );
  assert.equal(parse({ rootId: "/etc", categoryIds: ["logs"] }), false);
  assert.equal(
    parse({ rootId: "home", categoryIds: ["logs"], entryKeys: ["../../etc"] }),
    false,
  );
  assert.equal(
    parse({ rootId: "home", categoryIds: ["logs"], path: "/etc" }),
    false,
  );
});
