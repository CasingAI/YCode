import assert from "node:assert/strict";
import test from "node:test";
import type { SessionId } from "@zcode/contracts";
import { SandboxSnapshotSaveQueue } from "../src/sandbox/snapshot-save-queue.js";

test("快照保存依赖异常不阻断队列，后续保存仍可执行", async () => {
  const sessionId = "sess_snapshot_save_queue" as SessionId;
  let resolveDepsCalls = 0;
  const queue = new SandboxSnapshotSaveQueue(() => {
    if (resolveDepsCalls++ === 0) throw new Error("dependency unavailable");
    return { sandboxStorageRoot: undefined, fileSystemPort: undefined };
  });

  await assert.doesNotReject(queue.save(sessionId, { key: "first" }));
  assert.equal(queue.waitFor(sessionId), undefined);

  await assert.doesNotReject(queue.save(sessionId, { key: "second" }));
  assert.equal(resolveDepsCalls, 2);
});
