import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildRequiredPrebuiltArtifacts,
  findMissingPrebuiltArtifacts,
} from "./prebuilt-artifacts.mjs";
import { HISTORY_READ_LANE_WORKER_BUNDLE_NAME } from "../apps/zcode-cli/packages/cli/scripts/history-read-lane-worker-bundle.mjs";
import { SQLITE_READ_LANE_WORKER_BUNDLE_NAME } from "../apps/zcode-cli/packages/cli/scripts/sqlite-read-lane-worker-bundle.mjs";

test("预构建缺少 SQLite Worker 时将其列入缺失产物", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "zcode-prebuilt-artifacts-"));
  const desktopRoot = resolve(repoRoot, "packages/desktop");
  const artifacts = buildRequiredPrebuiltArtifacts({
    repoRoot,
    desktopRoot,
    platformKey: "darwin-arm64",
  });
  const sqliteWorker = artifacts.find((artifact) => artifact.label.includes("SQLite"));

  try {
    assert.ok(sqliteWorker);
    assert.equal(sqliteWorker.path.endsWith(SQLITE_READ_LANE_WORKER_BUNDLE_NAME), true);
    assert.equal(sqliteWorker.path.endsWith(HISTORY_READ_LANE_WORKER_BUNDLE_NAME), false);
    mkdirSync(join(repoRoot, "packages/desktop/bundled-agents/darwin-arm64/glm"), {
      recursive: true,
    });
    writeFileSync(
      join(repoRoot, "packages/desktop/bundled-agents/darwin-arm64/glm", "zcode.cjs"),
      "bundle\n",
      "utf8",
    );

    assert.ok(findMissingPrebuiltArtifacts(artifacts).includes(sqliteWorker));
    assert.deepEqual(
      findMissingPrebuiltArtifacts([sqliteWorker], () => true),
      [],
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
