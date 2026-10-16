import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import test from "node:test";
import {
  resolveOfficialPluginStorageRoot,
  resolveYCodeDataBaseDirSync,
} from "../src/node/ycodeConfigPaths.js";

// 数据分离：官方插件存储根固定为 `{dataBaseDir}/.ycode/cli/plugins`。

test("显式 env 指向 dataBaseDir 时官方存储根拼接正确", () => {
  const env = { ...process.env, ZCODE_DATA_BASE_DIR: "/tmp/yc-data" } as NodeJS.ProcessEnv;
  assert.equal(resolveYCodeDataBaseDirSync(env), "/tmp/yc-data");
  assert.equal(
    resolveOfficialPluginStorageRoot("/tmp/yc-data"),
    join("/tmp/yc-data", ".ycode", "cli", "plugins"),
  );
});

test("无 env 与 settings 时回退到 home", () => {
  const env = {
    ...process.env,
    HOME: "/tmp/fake-home",
    USERPROFILE: undefined,
    ZCODE_DATA_BASE_DIR: undefined,
    ZCODE_DESKTOP_HOME_DIR: undefined,
  } as unknown as NodeJS.ProcessEnv;
  delete env.ZCODE_DATA_BASE_DIR;
  delete env.ZCODE_DESKTOP_HOME_DIR;
  const base = resolveYCodeDataBaseDirSync(env);
  assert.ok(
    base === "/tmp/fake-home" || base === homedir(),
    `unexpected base: ${base}`,
  );
  assert.equal(
    resolveOfficialPluginStorageRoot(base),
    join(base, ".ycode", "cli", "plugins"),
  );
});
