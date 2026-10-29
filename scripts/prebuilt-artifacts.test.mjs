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
import { QUICKJS_WASM_FILE_NAME } from "../apps/zcode-cli/packages/cli/scripts/quickjs-wasm-bundle.mjs";
import { SANDBOX_WORKER_BUNDLE_NAME } from "../apps/zcode-cli/packages/cli/scripts/sandbox-worker-bundle.mjs";
import { SQLITE_READ_LANE_WORKER_BUNDLE_NAME } from "../apps/zcode-cli/packages/cli/scripts/sqlite-read-lane-worker-bundle.mjs";

test("预构建要求沙盒 Worker 与 QuickJS wasm 与 Agent bundle 同级", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "zcode-prebuilt-sandbox-assets-"));
  const desktopRoot = resolve(repoRoot, "packages/desktop");
  const artifacts = buildRequiredPrebuiltArtifacts({
    repoRoot,
    desktopRoot,
    platformKey: "darwin-arm64",
  });
  const sandboxWorker = artifacts.find((artifact) => artifact.label.includes("Sandbox QuickJS"));
  const quickjsWasm = artifacts.find((artifact) => artifact.label.includes("QuickJS wasm"));

  try {
    assert.ok(sandboxWorker);
    assert.equal(sandboxWorker.path.endsWith(SANDBOX_WORKER_BUNDLE_NAME), true);
    assert.ok(quickjsWasm);
    assert.equal(quickjsWasm.path.endsWith(QUICKJS_WASM_FILE_NAME), true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("预构建缺少沙盒 Worker 或 QuickJS wasm 时列入缺失产物", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "zcode-prebuilt-sandbox-missing-"));
  const desktopRoot = resolve(repoRoot, "packages/desktop");
  const artifacts = buildRequiredPrebuiltArtifacts({
    repoRoot,
    desktopRoot,
    platformKey: "darwin-arm64",
  });
  const sandboxWorker = artifacts.find((artifact) => artifact.label.includes("Sandbox QuickJS"));
  const quickjsWasm = artifacts.find((artifact) => artifact.label.includes("QuickJS wasm"));

  try {
    assert.ok(sandboxWorker);
    assert.ok(quickjsWasm);
    assert.ok(findMissingPrebuiltArtifacts([sandboxWorker]).includes(sandboxWorker));
    assert.ok(findMissingPrebuiltArtifacts([quickjsWasm]).includes(quickjsWasm));
    assert.deepEqual(
      findMissingPrebuiltArtifacts([sandboxWorker, quickjsWasm], () => true),
      [],
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

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
