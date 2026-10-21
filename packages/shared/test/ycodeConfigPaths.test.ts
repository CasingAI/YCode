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
      const {join} = await import('node:path');
      assert.equal(await p.initializeYCodeDatabaseMode(), false);
      assert.equal(await p.resolveYCodeStartupDataBaseDir(), process.env.HOME);
      assert.equal(paths.getTasksIndexDatabasePath(), join(process.env.HOME, '.zcode', 'v2', 'tasks-index.sqlite'));
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
      const {join} = await import('node:path');
      assert.equal(await p.initializeYCodeDatabaseMode(), true);
      assert.equal(paths.getTasksIndexDatabasePath(), join(process.env.HOME, '.ycode', 'v2', 'tasks-index.sqlite'));
      assert.equal(p.resolveYCodeSessionDatabasePath('~/.zcode/cli/db/db.sqlite'), join(process.env.HOME, '.ycode', 'cli', 'db', 'db.sqlite'));
      assert.equal(p.resolveYCodeSessionDatabasePath('/custom/db.sqlite'), '/custom/db.sqlite');
      await writeFile(join(process.env.HOME, '.ycode', 'v2', 'tasks-index.sqlite'), 'independent-marker');
      await writeFile(p.resolveYCodeSettingsFile(), JSON.stringify({useIndependentDatabase:false}));
      assert.equal(await p.initializeYCodeDatabaseMode(), true);
    `);
    await f.run(`
      const {join} = await import('node:path');
      assert.equal(await p.initializeYCodeDatabaseMode(), false);
      assert.equal(await readFile(join(process.env.HOME, '.ycode', 'v2', 'tasks-index.sqlite'),'utf8'), 'independent-marker');
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
      `const {join} = await import('node:path');
       assert.equal(await p.resolveYCodeStartupDataBaseDir(), join(process.env.HOME, 'custom'));`,
    );
  } finally {
    await f.dispose();
  }
});

test("渠道隔离根只隔离非数据库数据；任务索引库与默认工作区留在共享根", async () => {
  const f = await fixture();
  try {
    await f.run(
      `
      const {join} = await import('node:path');
      const {homedir} = await import('node:os');
      const shared = join(homedir(), '.zcode');
      // 数据库不跟随渠道隔离根：各渠道共用同一份任务历史。
      assert.equal(paths.getTasksIndexDatabasePath(), join(shared, 'v2', 'tasks-index.sqlite'));
      // 默认工作区是共享库里的会话寻址键，跟随隔离根会多出一条 default 谱系。
      assert.equal(paths.getConversationWorkspaceDir(), join(shared, 'workspace', 'default'));
      // 会话快照不是数据库，按渠道隔离留在隔离根。
      assert.equal(
        paths.getLegacyTaskSessionSnapshotPath('/workspace/demo', 'task-1'),
        join(
          process.env.ZCODE_DATA_BASE_DIR,
          '.zcode',
          'v2',
          'sessions',
          paths.getWorkspaceHash('/workspace/demo'),
          'task-1.json',
        ),
      );
      // 非数据库数据仍然按渠道隔离。
      assert.equal(paths.getAppConfigDir(), join(process.env.ZCODE_DATA_BASE_DIR, '.zcode', 'v2'));
      assert.equal(paths.getPersonalProviderConfigPath(), join(process.env.ZCODE_DATA_BASE_DIR, '.ycode', 'v2', 'provider_config.json'));
    `,
      { ZCODE_DATA_BASE_DIR: join(f.home, ".zcode-dev-home") },
    );
  } finally {
    await f.dispose();
  }
});

test("Windows 下 MSYS 风格 HOME 不会把数据根落到错位目录", async () => {
  if (process.platform !== "win32") return;
  const f = await fixture();
  try {
    await f.run(
      `
      const {join} = await import('node:path');
      const {homedir} = await import('node:os');
      // Windows 的 HOME 可能是 MSYS 风格（/c/Users/<name>），真实主目录取 os.homedir()。
      assert.equal(paths.getTasksIndexDatabasePath(), join(homedir(), '.zcode', 'v2', 'tasks-index.sqlite'));
      assert.equal(paths.getAppConfigDir(), join(homedir(), '.zcode', 'v2'));
    `,
      { HOME: "/c/Users/msys-home" },
    );
  } finally {
    await f.dispose();
  }
});
