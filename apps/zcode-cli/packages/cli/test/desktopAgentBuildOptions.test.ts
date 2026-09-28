import assert from "node:assert/strict";
import test from "node:test";
import { resolveBuildOptions } from "../scripts/build.mjs";

test("桌面 Agent 编译在显式开关打开时才递增 patch", () => {
  assert.equal(
    resolveBuildOptions(["--desktop-agent"], { ZCODE_BUMP_CLI_VERSION: "1" }).bumpPatch,
    true,
  );
  assert.equal(resolveBuildOptions(["--desktop-agent"], {}).bumpPatch, false);
  assert.equal(resolveBuildOptions([], { ZCODE_BUMP_CLI_VERSION: "1" }).bumpPatch, false);
});
