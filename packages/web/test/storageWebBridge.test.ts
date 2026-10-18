import assert from "node:assert/strict";
import test from "node:test";
import type { StorageUsageSnapshot } from "@zcode/shared";
import { createWebStorageBridge } from "../src/connection/storageWebBridge.js";

test("Web 桥仅允许远程扫描与清理，断线释放事件且没有原生 reveal", async () => {
  const events: Array<(value: StorageUsageSnapshot) => void> = [];
  const calls: string[] = [];
  const bridge = createWebStorageBridge({
    startScan: async () => {
      calls.push("start");
      return { jobId: "job-a" };
    },
    cancelScan: async (id) => {
      calls.push("cancel:" + id);
    },
    getSnapshot: async () => null,
    clean: async (request) => {
      calls.push("clean:" + request.rootId);
      return { deletedCount: 1, skippedCount: 0, failures: [] };
    },
    onScanProgress(listener) {
      events.push(listener);
      return {
        dispose: () => {
          calls.push("unsubscribe");
        },
      };
    },
  });
  assert.equal("revealPath" in bridge, false);
  const listener = bridge.subscribeScanProgress(() => {
    calls.push("progress");
  });
  assert.equal((await bridge.startScan()).jobId, "job-a");
  events[0]?.({
    jobId: "job-a",
    status: "complete",
    startedAt: 0,
    finishedAt: 1,
    roots: [],
    errors: [],
  });
  await bridge.cancelScan("job-a");
  assert.equal(
    (
      await bridge.clean({
        rootId: "home",
        categoryIds: ["logs"],
        ageRange: "all",
      })
    ).deletedCount,
    1,
  );
  listener();
  assert.deepEqual(calls, [
    "start",
    "progress",
    "cancel:job-a",
    "clean:home",
    "unsubscribe",
  ]);
});
