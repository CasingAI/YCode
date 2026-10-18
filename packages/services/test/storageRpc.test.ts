import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyChannel } from "@zcode/rpc";
import type { IStorageService } from "../src/storage/contract.js";
import { createStorageService } from "../src/storage/app/storageService.js";
import { createStorageRpcScope } from "../src/storage/adapters/storageRpcScope.js";
import { createFsStorageCleaner } from "../src/storage/adapters/fsCleaner.js";
import { runStorageScan } from "../src/storage/adapters/inProcessScanRunner.js";

test("存储 RPC 在临时目录扫描、清理和重扫，不暴露释放 owner", async () => {
  const path = await mkdtemp(join(tmpdir(), "ycode-storage-rpc-"));
  await mkdir(join(path, "cli/exec/sess_test"), { recursive: true });
  const file = join(path, "cli/exec/sess_test/output.txt");
  await writeFile(file, "temporary output");
  const owner = createStorageService({
    roots: {
      resolveRoots: async () => [
        { id: "home", path, hasCustomDataBaseDir: false },
      ],
    },
    scanRunner: { run: runStorageScan },
    cleaner: createFsStorageCleaner(),
  });
  const scope = createStorageRpcScope(owner);
  const channel = ProxyChannel.fromService(scope.service);
  const client = ProxyChannel.toService<IStorageService>({
    call: (command, args) => channel.call(undefined, command, args),
    listen: (event, arg) => channel.listen(undefined, event, arg),
  });
  const terminal = () =>
    new Promise<void>((resolve) => {
      const subscription = client.onScanProgress((snapshot) => {
        if (snapshot.status === "scanning") return;
        subscription.dispose();
        resolve();
      });
    });
  try {
    let done = terminal();
    await client.startScan();
    await done;
    assert.equal((await client.getSnapshot())?.roots[0]?.bytes, 16);
    assert.equal(await readFile(file, "utf8"), "temporary output");
    const result = await client.clean({
      rootId: "home",
      categoryIds: ["commandOutputs"],
      ageRange: "all",
    });
    assert.equal(result.deletedCount, 1);
    done = terminal();
    await client.startScan();
    await done;
    assert.equal((await client.getSnapshot())?.roots[0]?.bytes, 0);
    await assert.rejects(async () => channel.call(undefined, "dispose", []));
    for (const request of [
      { rootId: "../../outside", categoryIds: ["temporaryCaches"] },
      { rootId: "home", categoryIds: ["config"] },
      { rootId: "home", categoryIds: ["temporaryCaches"], ageRange: "typo" },
      {
        rootId: "home",
        categoryIds: ["temporaryCaches"],
        entryKeys: ["../outside"],
      },
      { rootId: "home", categoryIds: ["temporaryCaches"], path: "/outside" },
    ]) {
      await assert.rejects(client.clean(request as never));
    }
  } finally {
    scope.dispose();
    owner.dispose();
    await rm(path, { recursive: true, force: true });
  }
});

test("RPC attachment 释放只取消自己发起的任务", async () => {
  const cancellations: string[] = [];
  let counter = 0;
  const owner: IStorageService = {
    startScan: async () => ({ jobId: `job-${++counter}` }),
    cancelScan: async (id) => {
      cancellations.push(id);
    },
    getSnapshot: async () => null,
    clean: async () => ({ deletedCount: 0, skippedCount: 0, failures: [] }),
    onScanProgress: () => ({ dispose() {} }),
    dispose() {},
  };
  const a = createStorageRpcScope(owner);
  const b = createStorageRpcScope(owner);
  await a.service.startScan();
  await b.service.startScan();
  await a.service.cancelScan("job-2");
  assert.deepEqual(cancellations, []);
  a.dispose();
  assert.deepEqual(cancellations, ["job-1"]);
  b.dispose();
  assert.deepEqual(cancellations, ["job-1", "job-2"]);
});
