import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runSqliteSessionMigrations } from "../src/storage/session-store/migration-runner.js";
import {
  recoverInterruptedSessionTargetRun,
  recoverOrphanedActiveSessionTarget,
} from "../src/storage/session-target.js";

// 这条路径守的是会话恢复时「声称 active 却没有任何活跃 run」的僵尸 goal。
// 刚 set 的 Goal 在续跑登记 turn 之前也是这个组合，那是合法中间态，活会话读取不得调用这里。
// startSessionTargetRun 的 `where status='active'` 谓词保证真跑起来的 goal 会写入
// active_input_id；recoverInterruptedSessionTargetRun 要求 activeInputId 非空，
// 恰好覆盖不到崩溃后留下的空租约。原先若把收口挂在活会话读取上，刚提交的 Goal 会被掐死。

const SESSION_ID = "session-orphan";
const TARGET_ID = "target-orphan";
const BASE_TIME = 1_700_000_000_000;

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // 走生产迁移入口而不是手工 exec SQL：schema_migration 账本和各次 CHECK 约束的演进
  // 都由它负责，手工拼表迟早会和真实库结构漂移。
  runSqliteSessionMigrations(db, ":memory:");
  return db;
}

function insertSession(db: DatabaseSync): void {
  db.prepare(
    "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(SESSION_ID, "project", "slug", "/tmp/workspace", "会话", "1", BASE_TIME, BASE_TIME);
}

interface InsertTargetOptions {
  status?: string;
  activeInputId?: string | null;
  activeRunStartedAt?: number | null;
  activeRunLastSeenAt?: number | null;
  timeUsedSeconds?: number;
  timeUpdated?: number;
}

function insertTarget(db: DatabaseSync, options: InsertTargetOptions = {}): void {
  db.prepare(
    `insert into session_target (
       session_id, target_id, objective, status, token_budget, tokens_used,
       time_used_seconds, time_created, time_updated,
       active_input_id, active_run_started_at, active_run_last_seen_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SESSION_ID,
    TARGET_ID,
    "执行计划",
    options.status ?? "active",
    null,
    0,
    options.timeUsedSeconds ?? 0,
    BASE_TIME,
    options.timeUpdated ?? BASE_TIME,
    options.activeInputId ?? null,
    options.activeRunStartedAt ?? null,
    options.activeRunLastSeenAt ?? null,
  );
}

function readTargetStatus(db: DatabaseSync): {
  status: string;
  activeInputId: string | null;
  activeRunStartedAt: number | null;
  timeUsedSeconds: number;
} {
  const row = db
    .prepare(
      "select status, active_input_id, active_run_started_at, time_used_seconds from session_target where session_id = ?",
    )
    .get(SESSION_ID) as {
    status: string;
    active_input_id: string | null;
    active_run_started_at: number | null;
    time_used_seconds: number;
  };
  return {
    status: row.status,
    activeInputId: row.active_input_id,
    activeRunStartedAt: row.active_run_started_at,
    timeUsedSeconds: row.time_used_seconds,
  };
}

test("僵尸 goal（active 但无活跃 run）收口为 paused，且不虚增运行时长", () => {
  const db = createDb();
  insertSession(db);
  // time_updated 停在两天前，用来证明收口不会把离线时间算进 goal 运行时长。
  insertTarget(db, { status: "active", timeUsedSeconds: 1019, timeUpdated: BASE_TIME - 172_800_000 });

  const recovered = recoverOrphanedActiveSessionTarget(db, { sessionID: SESSION_ID });

  assert.equal(recovered?.status, "paused");
  assert.equal(recovered?.activeInputId ?? null, null);
  const stored = readTargetStatus(db);
  assert.equal(stored.status, "paused");
  // 从未开始计时，不该凭空多出时长。
  assert.equal(stored.timeUsedSeconds, 1019);
  db.close();
});

test("真有活跃 run 的 goal 不被僵尸收口误杀", () => {
  const db = createDb();
  insertSession(db);
  insertTarget(db, {
    status: "active",
    activeInputId: "input-running",
    activeRunStartedAt: BASE_TIME,
    activeRunLastSeenAt: BASE_TIME,
  });

  const untouched = recoverOrphanedActiveSessionTarget(db, { sessionID: SESSION_ID });

  assert.equal(untouched?.status, "active");
  assert.equal(untouched?.activeInputId, "input-running");
  db.close();
});

test("僵尸收口对已暂停、已完成与非 active 状态全部放行", () => {
  for (const status of ["paused", "complete", "budget_limited"]) {
    const db = createDb();
    insertSession(db);
    insertTarget(db, { status });

    const untouched = recoverOrphanedActiveSessionTarget(db, { sessionID: SESSION_ID });

    assert.equal(untouched?.status, status, `status=${status} 不应被改动`);
    db.close();
  }
});

test("既有 interrupted-run 恢复路径不覆盖僵尸组合，两条路径互补而非重复", () => {
  const db = createDb();
  insertSession(db);
  insertTarget(db, { status: "active" });

  // 老路径要求 activeInputId 非空，对僵尸组合直接原样返回。
  assert.equal(recoverInterruptedSessionTargetRun(db, { sessionID: SESSION_ID })?.status, "active");
  // 新路径才收得住它。
  assert.equal(recoverOrphanedActiveSessionTarget(db, { sessionID: SESSION_ID })?.status, "paused");
  db.close();
});
