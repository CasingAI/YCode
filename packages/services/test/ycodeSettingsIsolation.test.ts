import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSettingService } from "../src/setting/settingService.js";
import { copyDataDirectory } from "../src/paths.js";

test("设置不继承旧实验开关和 dataBaseDir，只写 .ycode；再次读取保持新值", async () => {
  const home = await mkdtemp(join(tmpdir(), "ycode-settings-"));
  const previous = process.env.ZCODE_DESKTOP_HOME_DIR;
  process.env.ZCODE_DESKTOP_HOME_DIR = home;
  try {
    const oldPath = join(home, ".zcode", "v2", "setting.json");
    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    const oldContent = JSON.stringify({
      useIndependentDatabase: true,
      dataBaseDir: "/legacy-root",
      automationEnabled: true,
    });
    await writeFile(oldPath, oldContent);
    const service = createSettingService();
    const defaults = await service.get();
    assert.equal(defaults.useIndependentDatabase, false);
    assert.equal(defaults.dataBaseDir, undefined);
    await service.update({ useIndependentDatabase: true });
    const stored = JSON.parse(await readFile(join(home, ".ycode", "v2", "setting.json"), "utf8"));
    assert.equal(stored.useIndependentDatabase, true);
    assert.equal((await createSettingService().get()).useIndependentDatabase, true);
    await service.update({ useIndependentDatabase: false });
    assert.equal((await service.get()).useIndependentDatabase, false);
    assert.equal(await readFile(oldPath, "utf8"), oldContent);
  } finally {
    if (previous === undefined) delete process.env.ZCODE_DESKTOP_HOME_DIR;
    else process.env.ZCODE_DESKTOP_HOME_DIR = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("旧思考显示字段不会触发设置迁移写入", async () => {
  const home = await mkdtemp(join(tmpdir(), "ycode-reasoning-settings-"));
  const previous = process.env.ZCODE_DESKTOP_HOME_DIR;
  process.env.ZCODE_DESKTOP_HOME_DIR = home;
  try {
    const settingsFile = join(home, ".ycode", "v2", "setting.json");
    await mkdir(join(home, ".ycode", "v2"), { recursive: true });
    const oldContent = JSON.stringify({
      messageStreamShowReasoning: false,
      messageStreamShowReasoningMigrationInitialized: true,
      closeToTrayOnWindowsMigrationInitialized: true,
    });
    await writeFile(settingsFile, oldContent);

    const settings = await createSettingService().get();

    assert.equal("messageStreamShowReasoning" in settings, false);
    assert.equal(await readFile(settingsFile, "utf8"), oldContent);
  } finally {
    if (previous === undefined) delete process.env.ZCODE_DESKTOP_HOME_DIR;
    else process.env.ZCODE_DESKTOP_HOME_DIR = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("用户显式修改数据根保留两个数据目录，固定 home 设置与任务索引库不复制", async () => {
  const home = await mkdtemp(join(tmpdir(), "ycode-data-root-"));
  try {
    const oldRoot = join(home, "old");
    const newRoot = join(home, "new");
    for (const product of [".zcode", ".ycode"]) {
      await mkdir(join(oldRoot, product, "v2"), { recursive: true });
      await writeFile(join(oldRoot, product, "v2", "tasks-index.sqlite"), product);
      await writeFile(join(oldRoot, product, "v2", "state.json"), product);
      await writeFile(join(oldRoot, product, "v2", "setting.json"), "excluded");
    }
    await writeFile(join(oldRoot, ".ycode", "v2", "provider_config.json"), "new-provider");
    await copyDataDirectory(oldRoot, newRoot);
    for (const product of [".zcode", ".ycode"]) {
      assert.equal(await readFile(join(newRoot, product, "v2", "state.json"), "utf8"), product);
      // 任务索引库固定在共享根（真实 home），唯一 owner 只有一个；搬迁不再复制，
      // 否则新数据根下会留下永远不被读取的副本。
      await assert.rejects(readFile(join(newRoot, product, "v2", "tasks-index.sqlite")), {
        code: "ENOENT",
      });
      await assert.rejects(readFile(join(newRoot, product, "v2", "setting.json")), {
        code: "ENOENT",
      });
    }
    assert.equal(
      await readFile(join(newRoot, ".ycode", "v2", "provider_config.json"), "utf8"),
      "new-provider",
    );
    assert.equal(
      await readFile(join(oldRoot, ".ycode", "v2", "provider_config.json"), "utf8"),
      "new-provider",
    );
    await copyDataDirectory(join(home, "missing"), join(home, "empty"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
