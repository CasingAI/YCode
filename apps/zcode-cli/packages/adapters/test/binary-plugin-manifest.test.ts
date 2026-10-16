import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverNodePluginsSync } from "../src/plugins/index.js";

// 第一切片（docs/specs/plugin-cli-proxy-binary.md）：manifest 顶层 cliProxy 声明
// 必须透传到 PluginMetadata.binaryPlugin；无声明的插件省略该字段。

function withPluginRoot(
  manifest: Record<string, unknown>,
  run: (root: string) => void,
): void {
  const storageRoot = mkdtempSync(join(tmpdir(), "zcode-binary-plugin-discover-"));
  const pluginRoot = join(storageRoot, "cli-proxy-plugin");
  try {
    mkdirSync(join(pluginRoot, ".zcode-plugin"), { recursive: true });
    writeFileSync(join(pluginRoot, ".zcode-plugin", "plugin.json"), JSON.stringify(manifest));
    run(pluginRoot);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
}

function discover(root: string) {
  return discoverNodePluginsSync({
    config: {
      dirs: [],
      enabled: true,
      enabledPlugins: {},
      extraKnownMarketplaces: {},
      options: {},
      suppressedBuiltins: [],
    },
    officialPluginRoots: [root],
    storageRoot: join(root, "..", "storage"),
    workingDirectory: root,
  });
}

test("manifest 的 cliProxy 声明透传为 binaryPlugin", () => {
  withPluginRoot(
    {
      name: "cli-proxy",
      version: "0.1.0",
      cliProxy: { releaseRepo: "router-for-me/CLIProxyAPI", defaultChannel: "stable" },
    },
    (root) => {
      const outcome = discover(root);
      assert.equal(outcome.plugins.length, 1);
      assert.deepEqual(outcome.plugins[0]?.binaryPlugin, {
        releaseRepo: "router-for-me/CLIProxyAPI",
        defaultChannel: "stable",
      });
    },
  );
});

test("无 cliProxy 声明的插件省略 binaryPlugin", () => {
  withPluginRoot({ name: "sandbox", version: "0.1.0" }, (root) => {
    const outcome = discover(root);
    assert.equal(outcome.plugins.length, 1);
    assert.equal(outcome.plugins[0]?.binaryPlugin, undefined);
  });
});
