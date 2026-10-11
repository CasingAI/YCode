import assert from "node:assert/strict";
import test from "node:test";
import type { FsCleanerPort, RootsResolverPort, ScanRunnerPort } from "../src/storage/app/ports.js";
import { createStorageService } from "../src/storage/app/storageService.js";
import type { StorageCleanCandidate } from "../src/storage/domain/cleanPlan.js";

const roots: RootsResolverPort = {
  resolveRoots: async () => [{ id: "home", path: "/tmp/zcode-home", hasCustomDataBaseDir: false }],
};

const scanRunner: ScanRunnerPort = {
  run: async () => ({ roots: [], errors: [] }),
};

function cleanerWith(candidatesByPrefix: Record<string, StorageCleanCandidate[]>) {
  const deleted: string[] = [];
  const cleaner: FsCleanerPort = {
    listCandidates: async (_rootPath, scopes) =>
      scopes.flatMap((scope) => candidatesByPrefix[scope.prefix] ?? []),
    deleteFiles: async (_rootPath, targets) => {
      for (const target of targets) deleted.push(target.relativePath);
      return {
        deletedCount: targets.length,
        freedBytes: targets.reduce((sum, target) => sum + target.bytes, 0),
        failures: [],
      };
    },
  };
  return { cleaner, deleted };
}

test("多类别一次清理：按类各自判定后合并结果", async () => {
  const now = Date.now();
  const { cleaner, deleted } = cleanerWith({
    "cli/exec": [
      { relativePath: "cli/exec/sess_old/call_1-stdout.log", bytes: 100, mtimeMs: now - 40 * 86400000 },
    ],
    "cli/image-cache": [
      { relativePath: "cli/image-cache/sess/a.png", bytes: 40, mtimeMs: now - 40 * 86400000 },
    ],
  });
  const service = createStorageService({ roots, scanRunner, cleaner, now: () => now });
  const result = await service.clean({
    rootId: "home",
    categoryIds: ["commandOutputs", "temporaryCaches"],
    olderThanMs: 30 * 86400000,
  });
  assert.equal(result.deletedCount, 2);
  assert.equal(result.freedBytes, 140);
  assert.equal(result.skippedCount, 0);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(deleted.sort(), [
    "cli/exec/sess_old/call_1-stdout.log",
    "cli/image-cache/sess/a.png",
  ]);
  service.dispose();
});

test("旧单类别入口仍兼容", async () => {
  const now = Date.now();
  const { cleaner } = cleanerWith({
    "cli/image-cache": [
      { relativePath: "cli/image-cache/sess/a.png", bytes: 40, mtimeMs: now - 40 * 86400000 },
    ],
  });
  const service = createStorageService({ roots, scanRunner, cleaner, now: () => now });
  const result = await service.clean({ rootId: "home", categoryId: "temporaryCaches" });
  assert.equal(result.deletedCount, 1);
  assert.equal(result.freedBytes, 40);
  service.dispose();
});

test("不可清理类别仍拒绝：会话库与运行时", async () => {
  const { cleaner } = cleanerWith({});
  const service = createStorageService({ roots, scanRunner, cleaner });
  await assert.rejects(service.clean({ rootId: "home", categoryId: "sessionStore" }));
  await assert.rejects(
    service.clean({ rootId: "home", categoryIds: ["temporaryCaches", "runtimes"] }),
  );
  service.dispose();
});

test("空类别组直接拒绝", async () => {
  const { cleaner } = cleanerWith({});
  const service = createStorageService({ roots, scanRunner, cleaner });
  await assert.rejects(service.clean({ rootId: "home" }));
  service.dispose();
});

test("沙盒按会话清：只删选中会话，未选中不动", async () => {
  const now = Date.now();
  const { cleaner, deleted } = cleanerWith({
    "cli/sandbox": [
      { relativePath: "cli/sandbox/sess_a/local-storage.json", bytes: 100, mtimeMs: 1 },
      { relativePath: "cli/sandbox/sess_b/local-storage.json", bytes: 50, mtimeMs: 1 },
    ],
  });
  const service = createStorageService({ roots, scanRunner, cleaner, now: () => now });
  const result = await service.clean({
    rootId: "home",
    categoryIds: ["sandbox"],
    entryKeys: ["cli/sandbox/sess_a"],
  });
  assert.equal(result.deletedCount, 1);
  assert.equal(result.freedBytes, 100);
  assert.deepEqual(deleted, ["cli/sandbox/sess_a/local-storage.json"]);
  service.dispose();
});

test("沙盒全清：不带 entryKeys 删整类", async () => {
  const now = Date.now();
  const { cleaner, deleted } = cleanerWith({
    "cli/sandbox": [
      { relativePath: "cli/sandbox/sess_a/local-storage.json", bytes: 100, mtimeMs: 1 },
      { relativePath: "cli/sandbox/sess_b/local-storage.json", bytes: 50, mtimeMs: 1 },
    ],
  });
  const service = createStorageService({ roots, scanRunner, cleaner, now: () => now });
  const result = await service.clean({ rootId: "home", categoryIds: ["sandbox"] });
  assert.equal(result.deletedCount, 2);
  assert.deepEqual(deleted.sort(), [
    "cli/sandbox/sess_a/local-storage.json",
    "cli/sandbox/sess_b/local-storage.json",
  ]);
  service.dispose();
});
