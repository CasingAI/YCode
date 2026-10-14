import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveOfficialPluginRoots } from "../src/app/bundled-plugins.js";
import type { Logger, LogContext } from "@zcode/contracts";

// 第一切片（docs/specs/plugin-cli-proxy-binary.md）：cli-proxy 种子包经 filesystem
// seed 进入 bundled marketplace 清单，real discovery 才能扫到它。

function createRecordingLogger(): { warns: unknown[]; logger: Logger } {
  const warns: unknown[] = [];
  return {
    logger: {
      child: () => {
        throw new Error("child 不应在本次测试中被调用");
      },
      debug() {},
      error() {},
      info() {},
      warn(message: string, context?: LogContext) {
        warns.push({ context, message });
      },
    },
    warns,
  };
}

function withTempRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "zcode-cli-proxy-seed-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("cli-proxy 种子包进入 bundled marketplace 清单", () => {
  withTempRoot((storageRoot) => {
    const { logger, warns } = createRecordingLogger();
    const baseDir = join(storageRoot, "candidate");
    const pluginRoot = join(baseDir, "packages", "cli-proxy-plugin", ".zcode-plugin");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(
      join(pluginRoot, "plugin.json"),
      JSON.stringify({
        name: "cli-proxy",
        version: "0.1.0",
        description: "CLI Proxy binary plugin",
        cliProxy: { releaseRepo: "router-for-me/CLIProxyAPI" },
      }),
    );

    resolveOfficialPluginRoots({ logger, seedCandidateBaseDirs: [baseDir], storageRoot });

    assert.equal(warns.length, 0);
    const partition = JSON.parse(
      readFileSync(
        join(storageRoot, "marketplaces", "zcode-plugins-official", "bundled-marketplace.json"),
        "utf8",
      ),
    ) as { manifest: { plugins: Array<{ name: string; version: string }> } };
    const entry = partition.manifest.plugins.find((plugin) => plugin.name === "cli-proxy");
    assert.ok(entry, "bundled 清单必须包含 cli-proxy");
    assert.equal(entry.version, "0.1.0");
  });
});
