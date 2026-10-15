import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { NodeFileSystemAdapter } from "../../adapters/src/fs/index.js";
import { createSqliteReadPort } from "../../adapters/src/sqlite-read/index.js";
import type { CollaborationMode, SessionId } from "@zcode/contracts";
import { SandboxInstance } from "../src/sandbox/instance.js";

const SESSION = "sess_test_sandbox_sqlite" as SessionId;

async function evalText(instance: SandboxInstance, code: string): Promise<string> {
  const outcome = await instance.eval(code);
  assert.equal(
    outcome.result.kind,
    "completed",
    outcome.result.kind === "failed"
      ? `${outcome.result.error.code}: ${outcome.result.error.message}`
      : "",
  );
  assert.equal(outcome.alive, true);
  if (outcome.result.kind !== "completed") return "";
  return outcome.result.returnText ?? "";
}

async function withSqlite(
  mode: CollaborationMode,
  setup: (root: string) => Promise<void>,
  run: (instance: SandboxInstance, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-sandbox-sqlite-"));
  await setup(root);
  const fsPort = new NodeFileSystemAdapter();
  const sqlitePort = createSqliteReadPort();
  const instance = await SandboxInstance.create(
    undefined,
    {
      sessionId: SESSION,
      resolve: () => ({
        sessionId: SESSION,
        fileSystemPort: fsPort,
        mode,
        workingDirectory: root,
        workspaceRoot: root,
      }),
    },
    undefined,
    {
      sessionId: SESSION,
      resolve: () => ({
        sessionId: SESSION,
        sqliteReadPort: sqlitePort,
        mode,
        workingDirectory: root,
        workspaceRoot: root,
      }),
    },
  );
  try {
    await run(instance, root);
  } finally {
    instance.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

async function seedDb(dbPath: string): Promise<void> {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)");
    db.exec("INSERT INTO users (name, age) VALUES ('amy', 30), ('bob', 25)");
  } finally {
    db.close();
  }
}

test("sandbox require sqlite 与 node:sqlite 同一对象，未登记 id 仍 SANDBOX_NO_MODULE", async () => {
  await withSqlite(
    "yolo",
    async (root) => {
      await seedDb(join(root, "a.db"));
    },
    async (instance) => {
      assert.equal(
        await evalText(
          instance,
          `const a = require("sqlite"); const b = require("node:sqlite"); return a === b ? "same" : "diff";`,
        ),
        "same",
      );
      assert.equal(
        await evalText(
          instance,
          `try { require("node:better-sqlite3"); return "leaked"; } catch (e) { return e.code; }`,
        ),
        "SANDBOX_NO_MODULE",
      );
    },
  );
});

test("query 读到行，tables 列出表", async () => {
  await withSqlite(
    "yolo",
    async (root) => {
      await seedDb(join(root, "a.db"));
    },
    async (instance) => {
      assert.equal(
        await evalText(
          instance,
          `const { query } = require("node:sqlite"); const rows = await query("a.db", "SELECT name FROM users ORDER BY age"); return rows.map(r => r.name).join(",");`,
        ),
        "bob,amy",
      );
      assert.equal(
        await evalText(
          instance,
          `const { tables } = require("node:sqlite"); return (await tables("a.db")).join(",");`,
        ),
        "users",
      );
    },
  );
});

test("import 写法落到同一对象", async () => {
  await withSqlite(
    "yolo",
    async (root) => {
      await seedDb(join(root, "a.db"));
    },
    async (instance) => {
      assert.equal(
        await evalText(
          instance,
          `import { query } from "node:sqlite"; const rows = await query("a.db", "SELECT count(*) AS n FROM users"); return String(rows[0].n);`,
        ),
        "2",
      );
    },
  );
});

test("工作区外可查：../ 指向的库读到行", async () => {
  const parent = await mkdtemp(join(tmpdir(), "zcode-sqlite-outside-"));
  const root = join(parent, "ws");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(root, { recursive: true });
  const outside = join(parent, "outside.db");
  const seed = new DatabaseSync(outside);
  seed.exec("CREATE TABLE t (x INT)");
  seed.exec("INSERT INTO t VALUES (7)");
  seed.close();
  const fsPort = new NodeFileSystemAdapter();
  const sqlitePort = createSqliteReadPort();
  const instance = await SandboxInstance.create(
    undefined,
    {
      sessionId: SESSION,
      resolve: () => ({
        sessionId: SESSION,
        fileSystemPort: fsPort,
        mode: "yolo",
        workingDirectory: root,
        workspaceRoot: root,
      }),
    },
    undefined,
    {
      sessionId: SESSION,
      resolve: () => ({
        sessionId: SESSION,
        sqliteReadPort: sqlitePort,
        mode: "yolo",
        workingDirectory: root,
        workspaceRoot: root,
      }),
    },
  );
  try {
    assert.equal(
      await evalText(
        instance,
        `const rows = await require("node:sqlite").query("../outside.db", "SELECT x FROM t"); return String(rows[0].x);`,
      ),
      "7",
    );
  } finally {
    instance.dispose();
    await rm(parent, { recursive: true, force: true });
  }
});

test("绝对路径指向工作区外可查：os.tmpdir 下的临时库（自清理）", async () => {
  const outsideDir = await mkdtemp(join(tmpdir(), "zcode-sqlite-tmpdb-"));
  const outside = join(outsideDir, "lib.db");
  const seed = new DatabaseSync(outside);
  seed.exec("CREATE TABLE kv (k TEXT, v INT)");
  seed.exec("INSERT INTO kv VALUES ('a', 1)");
  seed.close();
  await withSqlite(
    "yolo",
    async () => {},
    async (instance) => {
      assert.equal(
        await evalText(
          instance,
          `const rows = await require("node:sqlite").query(${JSON.stringify(outside)}, "SELECT v FROM kv"); return String(rows[0].v);`,
        ),
        "1",
      );
    },
  );
  await rm(outsideDir, { recursive: true, force: true });
});

test("符号链接指向工作区外同样可查", async () => {
  const parent = await mkdtemp(join(tmpdir(), "zcode-sqlite-jail-"));
  const root = join(parent, "ws");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(root, { recursive: true });
  const outside = join(parent, "outside.db");
  const seed = new DatabaseSync(outside);
  seed.exec("CREATE TABLE t (x INT)");
  seed.exec("INSERT INTO t VALUES (1)");
  seed.close();
  await seedDb(join(root, "a.db"));
  await symlink(outside, join(root, "escape.db"));
  const fsPort = new NodeFileSystemAdapter();
  const sqlitePort = createSqliteReadPort();
  const instance = await SandboxInstance.create(
    undefined,
    {
      sessionId: SESSION,
      resolve: () => ({
        sessionId: SESSION,
        fileSystemPort: fsPort,
        mode: "yolo",
        workingDirectory: root,
        workspaceRoot: root,
      }),
    },
    undefined,
    {
      sessionId: SESSION,
      resolve: () => ({
        sessionId: SESSION,
        sqliteReadPort: sqlitePort,
        mode: "yolo",
        workingDirectory: root,
        workspaceRoot: root,
      }),
    },
  );
  try {
    assert.equal(
      await evalText(
        instance,
        `const rows = await require("node:sqlite").query("escape.db", "SELECT * FROM t"); return String(rows.length);`,
      ),
      "1",
    );
  } finally {
    instance.dispose();
    await rm(parent, { recursive: true, force: true });
  }
});

test("ATTACH 被拒", async () => {
  await withSqlite(
    "yolo",
    async (root) => {
      await seedDb(join(root, "a.db"));
    },
    async (instance) => {
      assert.equal(
        await evalText(
          instance,
          `try { await require("node:sqlite").query("a.db", "ATTACH DATABASE 'a.db' AS other"); return "leaked"; } catch (e) { return e.code; }`,
        ),
        "SANDBOX_SQLITE_READ_ONLY",
      );
    },
  );
});

test("写入被拒", async () => {
  await withSqlite(
    "yolo",
    async (root) => {
      await seedDb(join(root, "a.db"));
    },
    async (instance) => {
      for (const [label, sql] of [
        ["insert", "INSERT INTO users (name) VALUES ('x')"],
        ["update", "UPDATE users SET age = 99"],
        ["drop", "DROP TABLE users"],
        ["create", "CREATE TABLE hacked (x INT)"],
        ["alter", "ALTER TABLE users ADD COLUMN nick TEXT"],
      ] as const) {
        assert.equal(
          await evalText(
            instance,
            `try { await require("node:sqlite").query("a.db", ${JSON.stringify(sql)}); return "leaked"; } catch (e) { return e.code; }`,
          ),
          "SANDBOX_SQLITE_READ_ONLY",
          label,
        );
      }
    },
  );
});

test("非法 params 形状为 SANDBOX_SQLITE_INVALID_PARAM", async () => {
  await withSqlite(
    "yolo",
    async (root) => {
      await seedDb(join(root, "a.db"));
    },
    async (instance) => {
      assert.equal(
        await evalText(
          instance,
          `try { await require("node:sqlite").query("a.db", "SELECT ?", [[1]]); return "ok"; } catch (e) { return e.code; }`,
        ),
        "SANDBOX_SQLITE_INVALID_PARAM",
      );
    },
  );
});

test("不存在的库与非数据库文件", async () => {
  await withSqlite(
    "yolo",
    async (root) => {
      await writeFile(join(root, "junk.db"), "not a database");
    },
    async (instance) => {
      assert.equal(
        await evalText(
          instance,
          `try { await require("node:sqlite").query("missing.db", "SELECT 1"); return "opened"; } catch (e) { return e.code; }`,
        ),
        "SANDBOX_SQLITE_NOT_FOUND",
      );
      assert.equal(
        await evalText(
          instance,
          `try { await require("node:sqlite").query("junk.db", "SELECT 1"); return "opened"; } catch (e) { return e.code; }`,
        ),
        "SANDBOX_SQLITE_NOT_A_DATABASE",
      );
    },
  );
});

test("行数触顶失败不截断", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-sqlite-limit-"));
  await seedDb(join(root, "a.db"));
  const fsPort = new NodeFileSystemAdapter();
  const sqlitePort = createSqliteReadPort({ maxRows: 1 });
  const instance = await SandboxInstance.create(
    undefined,
    {
      sessionId: SESSION,
      resolve: () => ({
        sessionId: SESSION,
        fileSystemPort: fsPort,
        mode: "yolo",
        workingDirectory: root,
        workspaceRoot: root,
      }),
    },
    undefined,
    {
      sessionId: SESSION,
      resolve: () => ({
        sessionId: SESSION,
        sqliteReadPort: sqlitePort,
        mode: "yolo",
        workingDirectory: root,
        workspaceRoot: root,
      }),
    },
  );
  try {
    assert.equal(
      await evalText(
        instance,
        `try { await require("node:sqlite").query("a.db", "SELECT * FROM users"); return "truncated"; } catch (e) { return e.code; }`,
      ),
      "SANDBOX_SQLITE_TOO_MANY_ROWS",
    );
  } finally {
    instance.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Ask/Plan 档可查询", async () => {
  for (const mode of ["plan", "readonly"] as CollaborationMode[]) {
    await withSqlite(
      mode,
      async (root) => {
        await seedDb(join(root, "a.db"));
      },
      async (instance) => {
        assert.equal(
          await evalText(
            instance,
            `const rows = await require("node:sqlite").query("a.db", "SELECT count(*) AS n FROM users"); return String(rows[0].n);`,
          ),
          "2",
        );
      },
    );
  }
});

test("大整数行：安全整数是数字，超限是字符串", async () => {
  await withSqlite(
    "yolo",
    async (root) => {
      await seedDb(join(root, "a.db"));
    },
    async (instance) => {
      assert.equal(
        await evalText(
          instance,
          `const rows = await require("node:sqlite").query("a.db", "SELECT 42 AS small, 9007199254740993 AS big"); return typeof rows[0].small + ":" + typeof rows[0].big + ":" + rows[0].big;`,
        ),
        "number:string:9007199254740993",
      );
    },
  );
});

test("reset 沙盒不影响其它连接：新实例仍可查", async () => {
  await withSqlite(
    "yolo",
    async (root) => {
      await seedDb(join(root, "a.db"));
    },
    async (instance) => {
      assert.equal(
        await evalText(
          instance,
          `globalThis.marker = 1; const rows = await require("node:sqlite").query("a.db", "SELECT 1 AS one"); return String(rows[0].one);`,
        ),
        "1",
      );
      instance.dispose();
      const fsPort = new NodeFileSystemAdapter();
      const sqlitePort = createSqliteReadPort();
      const root2 = await mkdtemp(join(tmpdir(), "zcode-sqlite-reset-"));
      await seedDb(join(root2, "b.db"));
      const fresh = await SandboxInstance.create(
        undefined,
        {
          sessionId: SESSION,
          resolve: () => ({
            sessionId: SESSION,
            fileSystemPort: fsPort,
            mode: "yolo",
            workingDirectory: root2,
            workspaceRoot: root2,
          }),
        },
        undefined,
        {
          sessionId: SESSION,
          resolve: () => ({
            sessionId: SESSION,
            sqliteReadPort: sqlitePort,
            mode: "yolo",
            workingDirectory: root2,
            workspaceRoot: root2,
          }),
        },
      );
      try {
        assert.equal(
          await evalText(
            fresh,
            `const leaked = typeof globalThis.marker === "undefined" ? "clean" : "leaked"; const rows = await require("node:sqlite").query("b.db", "SELECT count(*) AS n FROM users"); return leaked + ":" + rows[0].n;`,
          ),
          "clean:2",
        );
      } finally {
        fresh.dispose();
        await rm(root2, { recursive: true, force: true });
      }
    },
  );
});
