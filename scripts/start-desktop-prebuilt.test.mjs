import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("prebuilt --check completes its source freshness scan", () => {
  const result = spawnSync(
    process.execPath,
    [resolve(repoRoot, "scripts", "start-desktop-prebuilt.mjs"), "--check"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ZCODE_DATA_BASE_DIR: resolve(repoRoot, ".tmp-prebuilt-check"),
        ZCODE_PREBUILT_FORCE_BUILD: "",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /--check：将执行/);
  assert.doesNotMatch(result.stderr, /existsSync is not defined/);
});
