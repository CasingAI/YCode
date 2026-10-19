import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Host 磁盘 I/O 启动模块不能依赖 Electron 缺失的具名导出", () => {
  // Use a fresh Node ESM process without the Electron test stub. In this boundary,
  // `import { parentPort } from 'electron'` throws before Host can initialize.
  // Production Electron UtilityProcess also exposes the port on process.parentPort.
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'await import("./src/host/diskIoBootstrap.ts")',
    ],
    { cwd: desktopRoot, encoding: "utf8", timeout: 15_000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
