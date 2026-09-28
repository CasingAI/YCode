import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeCliVersionSidecar } from "../../../scripts/cli-version-sidecar.mjs";
import { stageAgentBundle } from "../scripts/stage-agent-bundle.mjs";

test("暂存会拷贝 sidecar 并把 cliVersion 写入 meta", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "zcode-stage-agent-"));
  const distDirectory = join(repoRoot, "apps/zcode-cli/packages/cli/dist");
  mkdirSync(distDirectory, { recursive: true });
  writeFileSync(join(distDirectory, "zcode.cjs"), "module.exports = {};\n", "utf8");
  writeCliVersionSidecar(distDirectory, "0.16.10");

  const result = stageAgentBundle({
    repoRoot,
    platformKey: "darwin-arm64",
    log() {},
  });

  assert.equal(result.cliVersion, "0.16.10");
  assert.match(readFileSync(result.stagedBundlePath, "utf8"), /module\.exports/);
  assert.equal(JSON.parse(readFileSync(result.stagedVersionSidecarPath, "utf8")).version, "0.16.10");
  assert.equal(JSON.parse(readFileSync(result.stagedMetaPath, "utf8")).cliVersion, "0.16.10");
});

test("缺少 sidecar 时暂存失败，不落下无版本产物", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "zcode-stage-agent-missing-"));
  const distDirectory = join(repoRoot, "apps/zcode-cli/packages/cli/dist");
  mkdirSync(distDirectory, { recursive: true });
  writeFileSync(join(distDirectory, "zcode.cjs"), "module.exports = {};\n", "utf8");

  assert.throws(
    () =>
      stageAgentBundle({
        repoRoot,
        platformKey: "darwin-arm64",
        log() {},
      }),
    /sidecar/,
  );
});
