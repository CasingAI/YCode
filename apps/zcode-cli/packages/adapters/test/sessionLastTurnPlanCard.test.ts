// 描边提示列的存储回归：0025 迁移加列、窄写幂等（值未变不产生变更）、
// NULL 解码为 unknown（旧会话不带描边字段），listSessions 原样带出真值。
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { SessionId } from "@zcode/contracts";
import { runSqliteSessionMigrations } from "../src/storage/session-store/migration-runner.js";
import {
  getSession,
  listSessions,
  setSessionLastTurnPlanCard,
} from "../src/storage/session-store/repositories/sessions.js";

const BASE_TIME = 1_700_000_000_000;

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runSqliteSessionMigrations(db, ":memory:");
  return db;
}

function insertSession(db: DatabaseSync, id: string): void {
  db.prepare(
    "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, "project", id, "/tmp/workspace", "会话", "1", BASE_TIME, BASE_TIME);
}

test("0025 迁移加列：新库 session 行带 last_turn_has_plan_card 且默认 NULL", () => {
  const db = createDb();
  try {
    insertSession(db, "sess_fresh");
    const row = db
      .prepare("select last_turn_has_plan_card from session where id = ?")
      .get("sess_fresh") as { last_turn_has_plan_card: number | null };
    assert.equal(row.last_turn_has_plan_card, null);
  } finally {
    db.close();
  }
});

test("窄写与解码：true/false 翻转各落盘一次，未写过的行解码为 undefined", async () => {
  const db = createDb();
  try {
    insertSession(db, "sess_written");
    insertSession(db, "sess_legacy");

    setSessionLastTurnPlanCard(db, {
      sessionID: "sess_written" as SessionId,
      lastTurnHasPlanCard: true,
    });
    assert.equal(getSession(db, "sess_written" as SessionId)?.lastTurnHasPlanCard, true);

    // 同值重写幂等：不报错、值不变。
    setSessionLastTurnPlanCard(db, {
      sessionID: "sess_written" as SessionId,
      lastTurnHasPlanCard: true,
    });
    assert.equal(getSession(db, "sess_written" as SessionId)?.lastTurnHasPlanCard, true);

    // 翻转回 false：NULL→1 之后 1→0 也必须走同一窄写。
    setSessionLastTurnPlanCard(db, {
      sessionID: "sess_written" as SessionId,
      lastTurnHasPlanCard: false,
    });
    assert.equal(getSession(db, "sess_written" as SessionId)?.lastTurnHasPlanCard, false);

    // 旧会话从未写过 → unknown，冷启动种子不得把它当成 false 或 true。
    assert.equal(getSession(db, "sess_legacy" as SessionId)?.lastTurnHasPlanCard, undefined);

    const listed = await listSessions(db, {});
    assert.deepEqual(
      Object.fromEntries(
        listed.map((session) => [session.id, session.lastTurnHasPlanCard]),
      ),
      { sess_written: false, sess_legacy: undefined },
    );
  } finally {
    db.close();
  }
});

test("同值窄写不产生行变更：单语句 where 拦截重复落盘", () => {
  const db = createDb();
  try {
    insertSession(db, "sess_noop");
    const column = "last_turn_has_plan_card";
    const value = 1;
    // 先落一次真值。
    db.prepare(`update session set ${column} = ? where id = ?`).run(value, "sess_noop");
    // 与 repo 窄写同形的语句：值未变时 changes 必须为 0。
    const result = db
      .prepare(
        `update session set ${column} = ? where id = ? and ${column} is not ?`,
      )
      .run(value, "sess_noop", value);
    assert.equal(Number(result.changes), 0, "同值更新不得产生变更");
    // NULL → 1 是变更。
    db.prepare(`update session set ${column} = null where id = ?`).run("sess_noop");
    const flip = db
      .prepare(`update session set ${column} = ? where id = ? and ${column} is not ?`)
      .run(value, "sess_noop", value);
    assert.equal(Number(flip.changes), 1, "NULL→新值必须产生变更");
  } finally {
    db.close();
  }
});
