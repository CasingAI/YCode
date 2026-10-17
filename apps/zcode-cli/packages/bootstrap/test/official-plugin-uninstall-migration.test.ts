import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getZCodePluginsOverview, uninstallZCodeMarketplacePlugin } from "../src/plugins.js";

const OFFICIAL_MARKETPLACE = "zcode-plugins-official";

function withTemp(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "zcode-plugin-uninstall-migration-"));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

function writePlugin(storageRoot: string, label: string, pluginId: string): string {
  const installPath = join(storageRoot, "cache", label, "example", "1.0.0");
  mkdirSync(join(installPath, ".zcode-plugin"), { recursive: true });
  writeFileSync(
    join(installPath, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ name: "example", version: "1.0.0" }),
  );
  const dataPath = join(storageRoot, "data", pluginId);
  mkdirSync(dataPath, { recursive: true });
  writeFileSync(join(dataPath, "user-data.txt"), label);
  return installPath;
}

function writeInstalledRecords(
  storageRoot: string,
  records: Array<{ id: string; marketplace: string; installPath: string; name?: string }>,
): void {
  mkdirSync(storageRoot, { recursive: true });
  writeFileSync(
    join(storageRoot, "installed_plugins.json"),
    JSON.stringify({
      plugins: records.map((record) => ({
        ...record,
        installedAt: new Date().toISOString(),
        scope: "user",
        version: "1.0.0",
      })),
      version: 1,
    }),
  );
}

function writeInstalledRecord(
  storageRoot: string,
  pluginId: string,
  marketplace: string,
  installPath: string,
): void {
  writeInstalledRecords(storageRoot, [{
    id: pluginId,
    name: "example",
    marketplace,
    installPath,
  }]);
}

function pluginOptions(root: string, pluginStorageRoot: string, officialPluginStorageRoot: string) {
  return {
    env: {},
    officialPluginStorageRoot,
    pluginStorageRoot,
    userConfigPath: join(root, "config.json"),
    workingDirectory: root,
  };
}

async function uninstall(input: {
  root: string;
  pluginId: string;
  pluginStorageRoot: string;
  officialPluginStorageRoot: string;
  removeCache?: boolean;
  keepData?: boolean;
}) {
  return uninstallZCodeMarketplacePlugin({
    env: {},
    officialPluginStorageRoot: input.officialPluginStorageRoot,
    pluginId: input.pluginId,
    pluginStorageRoot: input.pluginStorageRoot,
    removeCache: input.removeCache,
    keepData: input.keepData,
    userConfigPath: join(input.root, "config.json"),
    workingDirectory: input.root,
  });
}

test("旧插件根的官方安装记录按真实根卸载", async () => {
  await withTemp(async (root) => {
    const pluginStorageRoot = join(root, "legacy");
    const officialPluginStorageRoot = join(root, "official");
    const pluginId = `example@${OFFICIAL_MARKETPLACE}`;
    const oldInstallPath = writePlugin(pluginStorageRoot, "legacy", pluginId);
    writeInstalledRecord(pluginStorageRoot, pluginId, OFFICIAL_MARKETPLACE, oldInstallPath);

    const removed = await uninstall({
      root,
      pluginId,
      pluginStorageRoot,
      officialPluginStorageRoot,
    });

    assert.equal(removed?.id, pluginId);
    assert.equal(existsSync(oldInstallPath), false);
    assert.equal(existsSync(join(pluginStorageRoot, "data", pluginId)), false);
    assert.deepEqual(JSON.parse(readFileSync(join(pluginStorageRoot, "installed_plugins.json"), "utf8")).plugins, []);
  });
});

test("新旧根存在同 ID 时优先卸载官方根并清理迁移残留", async () => {
  await withTemp(async (root) => {
    const pluginStorageRoot = join(root, "legacy");
    const officialPluginStorageRoot = join(root, "official");
    const pluginId = `example@${OFFICIAL_MARKETPLACE}`;
    const oldInstallPath = writePlugin(pluginStorageRoot, "legacy", pluginId);
    const officialInstallPath = writePlugin(officialPluginStorageRoot, "official", pluginId);
    writeInstalledRecord(pluginStorageRoot, pluginId, OFFICIAL_MARKETPLACE, oldInstallPath);
    writeInstalledRecord(officialPluginStorageRoot, pluginId, OFFICIAL_MARKETPLACE, officialInstallPath);

    const removed = await uninstall({
      root,
      pluginId,
      pluginStorageRoot,
      officialPluginStorageRoot,
      keepData: true,
    });

    assert.equal(removed?.installPath, officialInstallPath);
    assert.equal(existsSync(oldInstallPath), false);
    assert.equal(existsSync(officialInstallPath), false);
    assert.equal(existsSync(join(pluginStorageRoot, "data", pluginId)), true);
    assert.equal(existsSync(join(officialPluginStorageRoot, "data", pluginId)), true);
    assert.deepEqual(
      JSON.parse(readFileSync(join(pluginStorageRoot, "installed_plugins.json"), "utf8")).plugins,
      [],
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(officialPluginStorageRoot, "installed_plugins.json"), "utf8")).plugins,
      [],
    );
  });
});

test("概览忽略旧根官方残留及官方根中的第三方记录，并以官方根更新官方插件", async () => {
  await withTemp(async (root) => {
    const pluginStorageRoot = join(root, "legacy");
    const officialPluginStorageRoot = join(root, "official");
    const officialId = `example@${OFFICIAL_MARKETPLACE}`;
    const thirdPartyId = "official-root-plugin@third-party";
    const legacyOfficialPath = writePlugin(pluginStorageRoot, "legacy-official", officialId);
    const officialInstallPath = writePlugin(officialPluginStorageRoot, "official", officialId);
    const misplacedThirdPartyPath = writePlugin(
      officialPluginStorageRoot,
      "misplaced-third-party",
      thirdPartyId,
    );
    writeInstalledRecords(pluginStorageRoot, [
      { id: officialId, name: "example", marketplace: OFFICIAL_MARKETPLACE, installPath: legacyOfficialPath },
    ]);
    writeInstalledRecords(officialPluginStorageRoot, [
      { id: officialId, name: "example", marketplace: OFFICIAL_MARKETPLACE, installPath: officialInstallPath },
      { id: thirdPartyId, name: "official-root-plugin", marketplace: "third-party", installPath: misplacedThirdPartyPath },
    ]);

    const overview = getZCodePluginsOverview(
      pluginOptions(root, pluginStorageRoot, officialPluginStorageRoot),
    );
    const listedIds = overview.installedPlugins.map((record) => record.id);
    assert.equal(listedIds.filter((id) => id === officialId).length, 1);
    assert.equal(listedIds.includes(thirdPartyId), false);

  });
});

test("第三方安装仍只从旧插件根卸载", async () => {
  await withTemp(async (root) => {
    const pluginStorageRoot = join(root, "legacy");
    const officialPluginStorageRoot = join(root, "official");
    const pluginId = "example@third-party";
    const installPath = writePlugin(pluginStorageRoot, "third-party", pluginId);
    const misplacedInstallPath = writePlugin(officialPluginStorageRoot, "misplaced-third-party", pluginId);
    writeInstalledRecord(pluginStorageRoot, pluginId, "third-party", installPath);
    writeInstalledRecord(officialPluginStorageRoot, pluginId, "third-party", misplacedInstallPath);

    const removed = await uninstall({
      root,
      pluginId,
      pluginStorageRoot,
      officialPluginStorageRoot,
      removeCache: false,
    });

    assert.equal(removed?.installPath, installPath);
    assert.equal(existsSync(installPath), true);
    assert.equal(existsSync(misplacedInstallPath), true);
    assert.equal(existsSync(join(pluginStorageRoot, "data", pluginId)), true);
    assert.deepEqual(JSON.parse(readFileSync(join(pluginStorageRoot, "installed_plugins.json"), "utf8")).plugins, []);
    assert.equal(
      JSON.parse(readFileSync(join(officialPluginStorageRoot, "installed_plugins.json"), "utf8")).plugins.length,
      1,
    );
  });
});
