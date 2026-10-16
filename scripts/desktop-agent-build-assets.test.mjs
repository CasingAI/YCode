import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeCliVersionSidecar } from "./cli-version-sidecar.mjs";
import { hasReusableDesktopAgentBundle } from "./desktop-agent-build-assets.mjs";
import { HISTORY_READ_LANE_WORKER_BUNDLE_NAME } from "../apps/zcode-cli/packages/cli/scripts/history-read-lane-worker-bundle.mjs";
import { SQLITE_READ_LANE_WORKER_BUNDLE_NAME } from "../apps/zcode-cli/packages/cli/scripts/sqlite-read-lane-worker-bundle.mjs";

function createBundleDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "zcode-desktop-agent-assets-"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "zcode.cjs"), "bundle\n", "utf8");
  writeFileSync(join(directory, HISTORY_READ_LANE_WORKER_BUNDLE_NAME), "history worker\n", "utf8");
  writeFileSync(join(directory, SQLITE_READ_LANE_WORKER_BUNDLE_NAME), "sqlite worker\n", "utf8");
  writeCliVersionSidecar(directory, "0.16.10");
  return directory;
}

test("桌面 Agent 构建仅复用包含 SQLite Worker 的完整 bundle", () => {
  const directory = createBundleDirectory();

  try {
    assert.equal(hasReusableDesktopAgentBundle(directory), true);
    rmSync(join(directory, SQLITE_READ_LANE_WORKER_BUNDLE_NAME));
    assert.equal(hasReusableDesktopAgentBundle(directory), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("桌面 Agent 构建不复用缺少 History Worker 的 bundle", () => {
  const directory = createBundleDirectory();

  try {
    rmSync(join(directory, HISTORY_READ_LANE_WORKER_BUNDLE_NAME));
    assert.equal(hasReusableDesktopAgentBundle(directory), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
