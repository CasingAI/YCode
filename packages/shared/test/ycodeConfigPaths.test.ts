import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const moduleUrl = new URL("../src/node/ycodeConfigPaths.ts", import.meta.url).href;
const pathsUrl = new URL("../../services/src/paths.ts", import.meta.url).href;
const root = fileURLToPath(new URL("../../../", import.meta.url));

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "ycode-startup-"));
  const settings = join(home, ".ycode", "v2", "setting.json");
  await mkdir(join(home, ".ycode", "v2"), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZCODE_DESKTOP_HOME_DIR: home };
  delete env.YCODE_INDEPENDENT_DATABASE;
  delete env.ZCODE_DATA_BASE_DIR;
  return {
    home,
    settings,
    async run(code: string, extra: Record<string, string> = {}) {
      const result = await execute(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
        import assert from 'node:assert/strict';
        import {writeFile, readFile} from 'node:fs/promises';
        import * as p from ${JSON.stringify(moduleUrl)};
        import * as paths from ${JSON.stringify(pathsUrl)};
        ${code}
      `,
        ],
        { cwd: root, env: { ...env, ...extra } },
      );
      return result.stdout;
    },
    async dispose() {
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("数据库默认共享，不继承旧设置；显式数据根优先", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.home, ".zcode", "v2"), { recursive: true });
    await writeFile(
      join(f.home, ".zcode", "v2", "setting.json"),
      JSON.stringify({ useIndependentDatabase: true, dataBaseDir: "/not-inherited" }),
    );
    await f.run(`
      assert.equal(await p.initializeYCodeDatabaseMode(), false);
      assert.equal(await p.resolveYCodeStartupDataBaseDir(), process.env.HOME);
      assert.equal(paths.getTasksIndexDatabasePath(), process.env.HOME + '/.zcode/v2/tasks-index.sqlite');
      assert.equal(p.resolveYCodeSessionDatabasePath('~/.zcode/cli/db/db.sqlite'), '~/.zcode/cli/db/db.sqlite');
      assert.equal(await p.resolveYCodeStartupDataBaseDir({...process.env, ZCODE_DATA_BASE_DIR:'/explicit'}), '/explicit');
    `);
  } finally {
    await f.dispose();
  }
});

test("保存开关不热切换；重启切入独立库，关闭再重启切回，独立数据保留", async () => {
  const f = await fixture();
  try {
    await f.run(`
      assert.equal(await p.initializeYCodeDatabaseMode(), false);
      await writeFile(p.resolveYCodeSettingsFile(), JSON.stringify({useIndependentDatabase:true}));
      assert.equal(await p.initializeYCodeDatabaseMode(), false);
      assert.equal(p.getYCodeIndependentDatabaseMode(), false);
    `);
    await f.run(`
      assert.equal(await p.initializeYCodeDatabaseMode(), true);
      assert.equal(paths.getTasksIndexDatabasePath(), process.env.HOME + '/.ycode/v2/tasks-index.sqlite');
      assert.equal(p.resolveYCodeSessionDatabasePath('~/.zcode/cli/db/db.sqlite'), process.env.HOME + '/.ycode/cli/db/db.sqlite');
      assert.equal(p.resolveYCodeSessionDatabasePath('/custom/db.sqlite'), '/custom/db.sqlite');
      await writeFile(process.env.HOME + '/.ycode/v2/tasks-index.sqlite', 'independent-marker');
      await writeFile(p.resolveYCodeSettingsFile(), JSON.stringify({useIndependentDatabase:false}));
      assert.equal(await p.initializeYCodeDatabaseMode(), true);
    `);
    await f.run(`
      assert.equal(await p.initializeYCodeDatabaseMode(), false);
      assert.equal(await readFile(process.env.HOME + '/.ycode/v2/tasks-index.sqlite','utf8'), 'independent-marker');
    `);
    await writeFile(f.settings, JSON.stringify({ useIndependentDatabase: true }));
    await f.run(`assert.equal(await p.initializeYCodeDatabaseMode(), true);`);
    assert.equal(
      await readFile(join(f.home, ".ycode", "v2", "tasks-index.sqlite"), "utf8"),
      "independent-marker",
    );
  } finally {
    await f.dispose();
  }
});

test("后续 Agent 继承 Host 有效模式，不消费磁盘待重启偏好", async () => {
  const f = await fixture();
  try {
    await writeFile(f.settings, JSON.stringify({ useIndependentDatabase: true }));
    await f.run(`assert.equal(await p.initializeYCodeDatabaseMode(), false);`, {
      YCODE_INDEPENDENT_DATABASE: "false",
    });
    await writeFile(f.settings, JSON.stringify({ useIndependentDatabase: false }));
    await f.run(`assert.equal(await p.initializeYCodeDatabaseMode(), true);`, {
      YCODE_INDEPENDENT_DATABASE: "true",
    });
    await f.run(
      `await assert.rejects(p.initializeYCodeDatabaseMode(), /Invalid YCode database mode/);`,
      { YCODE_INDEPENDENT_DATABASE: "invalid" },
    );
  } finally {
    await f.dispose();
  }
});

test("非法新设置使用默认模式，合法新设置解析数据根", async () => {
  const f = await fixture();
  try {
    for (const raw of ["null", "[]", "{", '{"useIndependentDatabase":"true"}']) {
      await writeFile(f.settings, raw);
      await f.run(`assert.equal(await p.initializeYCodeDatabaseMode(), false);`);
    }
    await writeFile(f.settings, JSON.stringify({ dataBaseDir: join(f.home, "custom") }));
    await f.run(
      `assert.equal(await p.resolveYCodeStartupDataBaseDir(), process.env.HOME + '/custom');`,
    );
  } finally {
    await f.dispose();
  }
});
