import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { build } from "esbuild";
import { resolveBuildAliases } from "./build.mjs";

test("desktop Agent bundles the public ChatGPT plan subpath with its actual alias table", async () => {
  const cliDirectory = resolve(import.meta.dirname, "..");
  const rootDirectory = resolve(cliDirectory, "../..");
  const result = await build({
    stdin: {
      contents: 'export { CHATGPT_PLAN_PROVIDER_ID } from "@zcode/shared/chatgpt-plan";',
      resolveDir: cliDirectory,
    },
    alias: resolveBuildAliases({ cliDirectory, rootDirectory }),
    platform: "node",
    format: "cjs",
    bundle: true,
    write: false,
    metafile: true,
  });
  assert.ok(
    Object.keys(result.metafile.inputs).some((path) =>
      path.endsWith("packages/shared/src/chatgpt-plan.ts"),
    ),
  );
  assert.match(result.outputFiles[0].text, /openai-chatgpt-plan/);
});
