import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readCliVersionSidecarForBundle,
  readCliVersionSidecarAt,
} from "../src/runtime-tools/cliVersionSidecar.js";

test("读取 bundle 同级 sidecar 的版本", () => {
  const directory = mkdtempSync(join(tmpdir(), "zcode-cli-sidecar-"));
  writeFileSync(join(directory, "zcode.cjs"), "module.exports = {};\n", "utf8");
  writeFileSync(join(directory, "cli-version.json"), `${JSON.stringify({ version: "0.16.11" })}\n`);

  assert.equal(readCliVersionSidecarAt(directory), "0.16.11");
  assert.equal(readCliVersionSidecarForBundle(join(directory, "zcode.cjs")), "0.16.11");
});

test("sidecar 缺失或非法时视为没有版本", () => {
  const directory = mkdtempSync(join(tmpdir(), "zcode-cli-sidecar-missing-"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "zcode.cjs"), "module.exports = {};\n", "utf8");

  assert.equal(readCliVersionSidecarForBundle(join(directory, "zcode.cjs")), undefined);
  writeFileSync(join(directory, "cli-version.json"), `${JSON.stringify({ version: "dev" })}\n`);
  assert.equal(readCliVersionSidecarForBundle(join(directory, "zcode.cjs")), undefined);
});
