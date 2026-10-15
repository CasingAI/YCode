import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createSqliteReadLane,
  createSqliteReadPort,
  SqliteReadLane,
} from "../src/sqlite-read/index.js";
import {
  SQLITE_READ_LANE_WORKER_BUNDLE_NAME,
  resolveSqliteReadLaneWorkerUrl,
  sqliteReadLaneWorkerUrl,
} from "../src/sqlite-read/read-lane-worker-url.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function withSeedDb(run: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-sqlite-lane-"));
  const dbPath = join(dir, "seed.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)");
    db.exec("INSERT INTO users (name, age) VALUES ('amy', 30), ('bob', 25)");
  } finally {
    db.close();
  }
  try {
    await run(dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("resolveSqliteReadLaneWorkerUrl：源文件测试拉 adapters dist sibling", () => {
  const url = resolveSqliteReadLaneWorkerUrl({
    metaUrl:
      "file:///repo/apps/zcode-cli/packages/adapters/src/sqlite-read/read-lane-worker-url.ts",
  });
  assert.match(url.href, /\/dist\/sqlite-read\/read-lane-worker\.js$/);
});

test("resolveSqliteReadLaneWorkerUrl：CJS 单文件产物不读空的 import.meta.url", () => {
  const bundled = `/tmp/glm/${SQLITE_READ_LANE_WORKER_BUNDLE_NAME}`;
  const url = resolveSqliteReadLaneWorkerUrl({
    argv1: "/tmp/glm/zcode.cjs",
    bundledExists: (absolutePath) => absolutePath === bundled,
  });
  assert.equal(url.pathname.endsWith(`/${SQLITE_READ_LANE_WORKER_BUNDLE_NAME}`), true);
});

test("resolveSqliteReadLaneWorkerUrl：metaUrl 缺失时不得对 undefined 调 endsWith", () => {
  assert.throws(
    () => resolveSqliteReadLaneWorkerUrl({}),
    /Sqlite read lane worker entry is missing/,
  );
});

test("sqliteReadLaneWorkerUrl：CJS banner 定位优先于 import.meta.url", () => {
  const previous = (globalThis as { __zcodeSqliteReadLaneWorkerUrl?: unknown })
    .__zcodeSqliteReadLaneWorkerUrl;
  const expected = new URL(`file:///tmp/glm/${SQLITE_READ_LANE_WORKER_BUNDLE_NAME}`);
  (globalThis as { __zcodeSqliteReadLaneWorkerUrl?: () => URL }).__zcodeSqliteReadLaneWorkerUrl =
    () => expected;
  try {
    assert.equal(sqliteReadLaneWorkerUrl().href, expected.href);
  } finally {
    (globalThis as { __zcodeSqliteReadLaneWorkerUrl?: unknown }).__zcodeSqliteReadLaneWorkerUrl =
      previous;
  }
});

test("SqliteReadLane：并行入队实际串行", async () => {
  let current = 0;
  const lane = createSqliteReadLane({
    executeJob: async (job) => {
      current += 1;
      assert.equal(current, 1, "同时只应有一路作业在跑");
      await delay(20);
      current -= 1;
      return job.kind === "query" ? { kind: "query", rows: [] } : { kind: "tables", tables: [] };
    },
  });
  try {
    await Promise.all([
      lane.enqueue({ kind: "tables", dbPath: "/tmp/a.db" }),
      lane.enqueue({ kind: "tables", dbPath: "/tmp/a.db" }),
      lane.enqueue({ kind: "tables", dbPath: "/tmp/a.db" }),
    ]);
    assert.equal(lane.stats.maxObservedActive, 1);
    assert.equal(lane.stats.active, 0);
  } finally {
    lane.dispose();
  }
});

test("SqliteReadLane：排队中的作业 abort 后不执行", async () => {
  let calls = 0;
  const lane = createSqliteReadLane({
    executeJob: async () => {
      calls += 1;
      await delay(30);
      return { kind: "tables", tables: [] };
    },
  });
  try {
    const first = lane.enqueue({ kind: "tables", dbPath: "/tmp/a.db" });
    const controller = new AbortController();
    const queued = lane.enqueue({ kind: "tables", dbPath: "/tmp/a.db" }, controller.signal);
    controller.abort();
    await assert.rejects(queued, isAbortError);
    await first;
    assert.equal(calls, 1, "被取消的排队作业不得开跑");
  } finally {
    lane.dispose();
  }
});

test("SqliteReadLane：dispose 拒绝排队作业", async () => {
  const lane = new SqliteReadLane({
    executeJob: async () => {
      await delay(50);
      return { kind: "tables", tables: [] };
    },
  });
  const first = lane.enqueue({ kind: "tables", dbPath: "/tmp/a.db" });
  const queued = lane.enqueue({ kind: "tables", dbPath: "/tmp/a.db" });
  lane.dispose();
  await assert.rejects(first, isAbortError);
  await assert.rejects(queued, isAbortError);
});

test("真 worker：query 读到种子行，tables 列出表名", async () => {
  await withSeedDb(async (dbPath) => {
    const port = createSqliteReadPort();
    const queried = await port.query({ dbPath, sql: "SELECT name, age FROM users ORDER BY age" });
    assert.deepEqual(queried.rows, [
      { name: "bob", age: 25 },
      { name: "amy", age: 30 },
    ]);
    const listed = await port.listTables({ dbPath });
    assert.deepEqual(listed.tables, ["users"]);
  });
});

test("真 worker：带参查询与大整数交回字符串", async () => {
  await withSeedDb(async (dbPath) => {
    const port = createSqliteReadPort();
    const queried = await port.query({
      dbPath,
      sql: "SELECT name FROM users WHERE age > ?",
      params: [26],
    });
    assert.deepEqual(queried.rows, [{ name: "amy" }]);
    const big = await port.query({ dbPath, sql: "SELECT 9007199254740993 AS big" });
    assert.equal(typeof big.rows[0]?.["big"], "string");
    assert.equal(big.rows[0]?.["big"], "9007199254740993");
  });
});

test("真 worker：INSERT 被拒为 read_only", async () => {
  await withSeedDb(async (dbPath) => {
    const port = createSqliteReadPort();
    const error = await port.query({ dbPath, sql: "INSERT INTO users (name) VALUES ('x')" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(error instanceof Error, "写入必须失败");
    assert.equal((error as { code?: string }).code, "read_only");
  });
});

test("真 worker：ATTACH 被拒为 read_only", async () => {
  await withSeedDb(async (dbPath) => {
    const port = createSqliteReadPort();
    const error = await port.query({ dbPath, sql: `ATTACH DATABASE '${dbPath}' AS other` }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(error instanceof Error, "ATTACH 必须失败");
    assert.equal((error as { code?: string }).code, "read_only");
  });
});

test("真 worker：DDL 被拒为 read_only", async () => {
  await withSeedDb(async (dbPath) => {
    const port = createSqliteReadPort();
    for (const sql of [
      "DROP TABLE users",
      "CREATE TABLE hacked (x INT)",
      "ALTER TABLE users ADD COLUMN nick TEXT",
      "UPDATE users SET age = 99",
    ]) {
      const error = await port.query({ dbPath, sql }).then(
        () => undefined,
        (error: unknown) => error,
      );
      assert.ok(error instanceof Error, `必须失败: ${sql}`);
      assert.equal((error as { code?: string }).code, "read_only", sql);
    }
  });
});

test("真 worker：非法 params 形状为 invalid_param，不是 too_large", async () => {
  await withSeedDb(async (dbPath) => {
    const port = createSqliteReadPort();
    const error = await port
      .query({ dbPath, sql: "SELECT ?", params: [[1]] })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    assert.ok(error instanceof Error, "非法 params 必须失败");
    assert.equal((error as { code?: string }).code, "invalid_param");
  });
});

test("真 worker：不存在的库为 not_found，非数据库文件为 not_a_database", async () => {
  const port = createSqliteReadPort();
  const missing = await port
    .query({ dbPath: "/tmp/zcode-sqlite-no-such-dir/x.db", sql: "SELECT 1" })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert.equal((missing as { code?: string } | undefined)?.code, "not_found");
  const dir = await mkdtemp(join(tmpdir(), "zcode-sqlite-notdb-"));
  try {
    const junk = join(dir, "junk.db");
    await writeFile(junk, "this is not a database");
    const notDb = await port.query({ dbPath: junk, sql: "SELECT 1" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.equal((notDb as { code?: string } | undefined)?.code, "not_a_database");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("真 worker：行数触顶失败", async () => {
  await withSeedDb(async (dbPath) => {
    const port = createSqliteReadPort({ maxRows: 1 });
    const error = await port.query({ dbPath, sql: "SELECT * FROM users" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.equal((error as { code?: string } | undefined)?.code, "too_many_rows");
  });
});

test("真 worker：字节触顶失败", async () => {
  await withSeedDb(async (dbPath) => {
    const port = createSqliteReadPort({ maxResultBytes: 1 });
    const error = await port.query({ dbPath, sql: "SELECT * FROM users" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.equal((error as { code?: string } | undefined)?.code, "too_large");
  });
});

test("真 worker：取消排队中的作业不执行，当前作业不受影响", async () => {
  await withSeedDb(async (dbPath) => {
    const lane = createSqliteReadLane({ timeoutMs: 30_000 });
    try {
      const running = lane.enqueue({
        kind: "query",
        dbPath,
        sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 2000000) SELECT sum(x) AS s FROM c",
      });
      const controller = new AbortController();
      const queued = lane.enqueue({ kind: "tables", dbPath }, controller.signal);
      controller.abort();
      await assert.rejects(queued, isAbortError);
      const done = await running;
      assert.equal(done.kind, "query");
    } finally {
      lane.dispose();
    }
  });
});

test("真 worker：取消正在跑的作业按 AbortError 拒绝", async () => {
  await withSeedDb(async (dbPath) => {
    const lane = createSqliteReadLane();
    try {
      const controller = new AbortController();
      const running = lane.enqueue(
        {
          kind: "query",
          dbPath,
          sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 100000000) SELECT sum(x) FROM c",
        },
        controller.signal,
      );
      await delay(50);
      controller.abort();
      await assert.rejects(running, isAbortError);
    } finally {
      lane.dispose();
    }
  });
});

test("真 worker：慢查询被车道按时 terminate", async () => {
  await withSeedDb(async (dbPath) => {
    const lane = createSqliteReadLane({ timeoutMs: 200 });
    try {
      const error = await lane
        .enqueue({
          kind: "query",
          dbPath,
          sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 100000000) SELECT sum(x) FROM c",
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      assert.equal((error as { code?: string } | undefined)?.code, "timed_out");
    } finally {
      lane.dispose();
    }
  });
});
