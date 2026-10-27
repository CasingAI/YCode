import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";

interface ColumnInfo {
  name: string;
  notnull: number;
  dflt_value: string | null;
}

function taskColumns(db: DatabaseSync): ColumnInfo[] {
  return db.prepare("PRAGMA table_info(tasks)").all() as unknown as ColumnInfo[];
}

function migrationChecksums(db: DatabaseSync): Map<string, string> {
  const rows = db
    .prepare("SELECT id, checksum FROM tasks_schema_migration ORDER BY id")
    .all() as unknown as Array<{ id: string; checksum: string }>;
  return new Map(rows.map((row) => [row.id, row.checksum]));
}

test("0006 迁移新增已读水位列，重复执行幂等且不改历史 checksum", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-task-watermark-migration-"));
  const db = new DatabaseSync(join(dir, "tasks.sqlite"));
  try {
    runTasksDatabaseMigrations(db);
    const firstChecksums = migrationChecksums(db);
    assert.ok(firstChecksums.has("0001_adopt_task_schema"));
    assert.ok(firstChecksums.has("0005_delay_automation"));
    assert.ok(firstChecksums.has("0006_task_read_watermark"));

    const columns = taskColumns(db);
    const lastSeen = columns.find((column) => column.name === "last_seen_activity_at");
    const unreadActivity = columns.find((column) => column.name === "unread_activity_at");
    assert.ok(lastSeen, "必须新增 last_seen_activity_at");
    assert.equal(lastSeen.notnull, 1);
    assert.equal(lastSeen.dflt_value, "0");
    assert.ok(unreadActivity, "必须新增 unread_activity_at");
    assert.equal(unreadActivity.notnull, 0);

    // 模拟旧库：0006 尚未应用，两列不存在；重复 runner 必须重新补齐且历史 checksum 不变。
    db.exec("DELETE FROM tasks_schema_migration WHERE id='0006_task_read_watermark'");
    db.exec("ALTER TABLE tasks DROP COLUMN last_seen_activity_at");
    db.exec("ALTER TABLE tasks DROP COLUMN unread_activity_at");
    runTasksDatabaseMigrations(db);

    const upgradedColumns = taskColumns(db);
    assert.ok(upgradedColumns.some((column) => column.name === "last_seen_activity_at"));
    assert.ok(upgradedColumns.some((column) => column.name === "unread_activity_at"));
    const upgradedChecksums = migrationChecksums(db);
    assert.equal(
      upgradedChecksums.get("0001_adopt_task_schema"),
      firstChecksums.get("0001_adopt_task_schema"),
      "历史 0001 checksum 必须冻结",
    );
    assert.equal(
      upgradedChecksums.get("0005_delay_automation"),
      firstChecksums.get("0005_delay_automation"),
    );

    // 再跑一次：账本与列均已是目标状态，不应重复执行或报错。
    runTasksDatabaseMigrations(db);
    const ledgerRows = db
      .prepare(
        "SELECT COUNT(1) AS count FROM tasks_schema_migration WHERE id='0006_task_read_watermark'",
      )
      .get() as unknown as { count: number };
    assert.equal(ledgerRows.count, 1);
    assert.equal(
      taskColumns(db).filter((column) => column.name === "last_seen_activity_at").length,
      1,
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
