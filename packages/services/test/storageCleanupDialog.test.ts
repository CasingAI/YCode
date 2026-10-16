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
      return { deletedCount: targets.length, failures: [] };
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
    ageRange: "30days",
  });
  assert.equal(result.deletedCount, 2);
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
  assert.deepEqual(deleted, ["cli/sandbox/sess_a/local-storage.json"]);
  service.dispose();
});

test("全部删除会移除近期活跃文件且只返回文件数量", async () => {
  const now = Date.now();
  const { cleaner, deleted } = cleanerWith({
    "cli/exec": [
      { relativePath: "cli/exec/sess_active/call.txt", bytes: 100, mtimeMs: now - 60 * 60 * 1000 },
    ],
  });
  const service = createStorageService({ roots, scanRunner, cleaner, now: () => now });
  const result = await service.clean({
    rootId: "home",
    categoryIds: ["commandOutputs"],
    ageRange: "all",
  });
  assert.deepEqual(deleted, ["cli/exec/sess_active/call.txt"]);
  assert.equal(result.deletedCount, 1);
  assert.deepEqual(result.failures, []);
  assert.equal("freedBytes" in result, false);
  service.dispose();
});

test("清理删除失败时返回失败路径和系统错误码", async () => {
  const cleaner: FsCleanerPort = {
    listCandidates: async () => [
      { relativePath: "cli/image-cache/sess/a.png", bytes: 40, mtimeMs: 1 },
    ],
    deleteFiles: async () => ({
      deletedCount: 0,
      failures: [{ path: "cli/image-cache/sess/a.png", code: "EACCES" }],
    }),
  };
  const service = createStorageService({ roots, scanRunner, cleaner });
  const result = await service.clean({ rootId: "home", categoryId: "temporaryCaches" });
  assert.equal(result.deletedCount, 0);
  assert.deepEqual(result.failures, [{ path: "cli/image-cache/sess/a.png", code: "EACCES" }]);
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
