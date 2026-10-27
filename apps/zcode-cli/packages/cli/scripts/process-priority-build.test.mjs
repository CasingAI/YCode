import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { build } from "esbuild";
import { resolveBuildAliases } from "./build.mjs";

test("CLI bundles the public process-priority subpath with its actual alias table", async () => {
  const cliDirectory = resolve(import.meta.dirname, "..");
  const rootDirectory = resolve(cliDirectory, "../..");
  const result = await build({
    stdin: {
      contents: 'export { lowerProcessPriority } from "@zcode/shared/process-priority";',
      resolveDir: cliDirectory,
    },
    alias: resolveBuildAliases({ cliDirectory, rootDirectory }),
    platform: "node",
    format: "cjs",
    bundle: true,
    write: false,
    metafile: true,
  });
  // 漏声明精确 alias 时，通用 "@zcode/shared" 前缀会把导入拼成
  // `src/index.ts/process-priority`，打包直接失败；这里断言真实解析到独立入口。
  assert.ok(
    Object.keys(result.metafile.inputs).some((path) =>
      path.endsWith("packages/shared/src/node/processPriority.ts"),
    ),
  );
});
