import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bumpPackageVersion, bumpPatchVersion } from "../scripts/bump-build-version.mjs";

function createTempPackageJson(version: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "zcode-bump-version-"));
  const packageJsonPath = join(directory, "package.json");
  writeFileSync(
    packageJsonPath,
    `{\n  "name": "zcode",\n  "version": ${JSON.stringify(version)},\n  "private": true\n}\n`,
    "utf8",
  );
  return packageJsonPath;
}

test("patch 递增：3.14.0 递增为 3.14.1", () => {
  assert.equal(bumpPatchVersion("3.14.0"), "3.14.1");
});

test("patch 递增：连续递增保持单调", () => {
  let version = "3.14.0";
  const seen: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    version = bumpPatchVersion(version);
    seen.push(version);
  }
  assert.deepEqual(seen, ["3.14.1", "3.14.2", "3.14.3"]);
});

test("patch 溢出：9 进位到 10 而不是回到 0", () => {
  assert.equal(bumpPatchVersion("3.14.9"), "3.14.10");
  assert.equal(bumpPatchVersion("3.14.99"), "3.14.100");
});

test("非法版本号抛错，不静默回退", () => {
  assert.throws(() => bumpPatchVersion("3.14"), /must match/);
  assert.throws(() => bumpPatchVersion("3.14.0-dev.1"), /must match/);
  assert.throws(() => bumpPatchVersion("3.14.0+build.5"), /must match/);
  assert.throws(() => bumpPatchVersion(""), /must match/);
  assert.throws(() => bumpPatchVersion(undefined), /must be a string/);
});

test("写盘：版本号递增并落盘，文件其余内容与格式保持不变", () => {
  const packageJsonPath = createTempPackageJson("3.14.0");
  const before = readFileSync(packageJsonPath, "utf8");

  const result = bumpPackageVersion(packageJsonPath);
  const after = readFileSync(packageJsonPath, "utf8");

  assert.equal(result.previousVersion, "3.14.0");
  assert.equal(result.version, "3.14.1");
  assert.match(after, /"version": "3\.14\.1"/);
  // diff 必须只落在版本号那一行，否则 package.json 的改动会被重排键序的噪声淹没。
  assert.equal(after, before.replace('"version": "3.14.0"', '"version": "3.14.1"'));
});

test("dry-run：只计算不写盘，文件内容保持原样", () => {
  const packageJsonPath = createTempPackageJson("3.14.0");
  const before = readFileSync(packageJsonPath, "utf8");

  const result = bumpPackageVersion(packageJsonPath, { dryRun: true });

  assert.equal(result.version, "3.14.1");
  assert.equal(readFileSync(packageJsonPath, "utf8"), before);
});
