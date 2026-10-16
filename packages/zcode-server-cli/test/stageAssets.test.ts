import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HISTORY_READ_LANE_WORKER_BUNDLE_NAME,
  SQLITE_READ_LANE_WORKER_BUNDLE_NAME,
  assertAgentBundleAssetsExist,
  resolveAgentBundleAssets,
  stageAgentBundleAssets,
} from "../src/packaging/stageAssets.js";

async function withAgentAssets(run: (distDir: string, runtimeDir: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "zcode-server-agent-assets-"));
  const distDir = join(root, "dist");
  const runtimeDir = join(root, "release", "runtime");
  const assets = resolveAgentBundleAssets(distDir);
  try {
    await mkdir(distDir, { recursive: true });
    await Promise.all(
      Object.entries(assets).map(([name, path]) => writeFile(path, `${name}\n`, "utf8")),
    );
    await run(distDir, runtimeDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Agent runtime 暂存 zcode.cjs 和两个同级只读 worker", async () => {
  await withAgentAssets(async (distDir, runtimeDir) => {
    const assets = resolveAgentBundleAssets(distDir);
    await assertAgentBundleAssetsExist(assets);
    await stageAgentBundleAssets(assets, runtimeDir);

    assert.equal(await readFile(join(runtimeDir, "zcode.cjs"), "utf8"), "bundlePath\n");
    assert.equal(
      await readFile(join(runtimeDir, HISTORY_READ_LANE_WORKER_BUNDLE_NAME), "utf8"),
      "historyReadLaneWorkerPath\n",
    );
    assert.equal(
      await readFile(join(runtimeDir, SQLITE_READ_LANE_WORKER_BUNDLE_NAME), "utf8"),
      "sqliteReadLaneWorkerPath\n",
    );
  });
});

test("缺少 SQLite worker 时 Agent runtime 暂存明确失败", async () => {
  await withAgentAssets(async (distDir, runtimeDir) => {
    const assets = resolveAgentBundleAssets(distDir);
    await rm(assets.sqliteReadLaneWorkerPath);

    await assert.rejects(
      stageAgentBundleAssets(assets, runtimeDir),
      (error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" && error.message.includes(SQLITE_READ_LANE_WORKER_BUNDLE_NAME),
    );
  });
});
