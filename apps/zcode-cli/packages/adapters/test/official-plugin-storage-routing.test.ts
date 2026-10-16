import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverNodePluginsSync } from "../src/plugins/index.js";
import { writeBundledOfficialMarketplacePartitionSync } from "../src/plugins/official-marketplace.js";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";

// 官方插件缓存迁移：bundled seed + 官方市场安装走 officialStorageRoot，
// 第三方插件缓存/安装记录/用户数据仍走原 storageRoot；旧目录官方安装不再加载。

function baseConfig() {
  return {
    dirs: [],
    enabled: true,
    enabledPlugins: {},
    extraKnownMarketplaces: {},
    options: {},
    suppressedBuiltins: [],
  };
}

function withTemp(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "zcode-official-routing-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writePluginRoot(root: string, name: string, version = "0.1.0"): string {
  const pluginRoot = join(root, name, version);
  mkdirSync(join(pluginRoot, ".zcode-plugin"), { recursive: true });
  writeFileSync(
    join(pluginRoot, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ description: "test", name, version }),
  );
  return pluginRoot;
}

function writeOfficialPartition(officialStorageRoot: string, cachePath: string): void {
  writeBundledOfficialMarketplacePartitionSync({
    manifest: {
      name: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      plugins: [
        { cachePath, name: "seeded", source: "filesystem", version: "0.1.0" },
      ],
      version: 1,
    },
    storageRoot: officialStorageRoot,
  });
}

function writeInstalledRecord(
  storageRoot: string,
  record: { id: string; installPath: string; marketplace: string; name: string },
): void {
  writeFileSync(
    join(storageRoot, "installed_plugins.json"),
    JSON.stringify({
      plugins: [
        {
          ...record,
          installedAt: new Date().toISOString(),
          scope: "user",
          updatedAt: new Date().toISOString(),
          version: "0.1.0",
        },
      ],
      version: 1,
    }),
  );
}

test("官方 bundled 缓存从 officialStorageRoot 发现，不读旧 storageRoot", () => {
  withTemp((root) => {
    const storageRoot = join(root, "legacy");
    const officialStorageRoot = join(root, "official");
    const cachePath = writePluginRoot(join(officialStorageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE), "seeded");
    writeOfficialPartition(officialStorageRoot, cachePath);
    // 旧目录放一个同名干扰缓存：没有授权清单时也不得被加载。
    writePluginRoot(join(storageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE), "seeded");

    const outcome = discoverNodePluginsSync({
      config: baseConfig(),
      officialStorageRoot,
      storageRoot,
      workingDirectory: root,
    });
    assert.deepEqual(
      outcome.plugins.filter((plugin) => plugin.source === "official").map((plugin) => plugin.rootPath),
      [cachePath],
    );
  });
});

test("旧 storageRoot 残留的官方安装记录不再加载，需重装", () => {
  withTemp((root) => {
    const storageRoot = join(root, "legacy");
    const officialStorageRoot = join(root, "official");
    mkdirSync(storageRoot, { recursive: true });
    mkdirSync(officialStorageRoot, { recursive: true });
    const staleRoot = writePluginRoot(join(storageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE), "stale-cdn");
    writeInstalledRecord(storageRoot, {
      id: `stale-cdn@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
      installPath: staleRoot,
      marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      name: "stale-cdn",
    });

    const outcome = discoverNodePluginsSync({
      config: baseConfig(),
      officialStorageRoot,
      storageRoot,
      workingDirectory: root,
    });
    assert.equal(
      outcome.plugins.some((plugin) => plugin.id === `stale-cdn@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`),
      false,
    );
  });
});

test("官方市场安装走官方存储根，第三方安装仍走原存储根", () => {
  withTemp((root) => {
    const storageRoot = join(root, "legacy");
    const officialStorageRoot = join(root, "official");
    mkdirSync(storageRoot, { recursive: true });
    mkdirSync(officialStorageRoot, { recursive: true });
    const officialRoot = writePluginRoot(join(officialStorageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE), "cdn-plugin");
    writeInstalledRecord(officialStorageRoot, {
      id: `cdn-plugin@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
      installPath: officialRoot,
      marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      name: "cdn-plugin",
    });
    const thirdPartyRoot = writePluginRoot(join(storageRoot, "cache", "third-party"), "tp");
    mkdirSync(join(thirdPartyRoot, ".zcode-plugin"), { recursive: true });
    writeInstalledRecord(storageRoot, {
      id: "tp@third-party",
      installPath: thirdPartyRoot,
      marketplace: "third-party",
      name: "tp",
    });

    const outcome = discoverNodePluginsSync({
      config: baseConfig(),
      officialStorageRoot,
      storageRoot,
      workingDirectory: root,
    });
    const byId = new Map(outcome.plugins.map((plugin) => [plugin.id, plugin.rootPath]));
    assert.equal(byId.get(`cdn-plugin@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`), officialRoot);
    assert.equal(byId.get("tp@third-party"), thirdPartyRoot);
  });
});
