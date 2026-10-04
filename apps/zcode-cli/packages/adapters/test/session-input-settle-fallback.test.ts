import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runSqliteSessionMigrations } from "../src/storage/session-store/migration-runner.js";
import {
  markSessionInputPromoted,
  saveSessionInput,
  settleSessionInput,
} from "../src/storage/session-store/repositories/session-inputs.js";

// turn.ts 的 finally 兜底完全依赖这两条不变量：
// 1) 收口是终结性的——admitted 行一旦被 settle 成 failed，session FIFO 就被释放，
//    后续用户输入不会继续卡在它后面；
// 2) 收口是幂等的——UPDATE 带 where status='admitted'，所以成功路径上 turn 正常跑完再调一次
//    是 no-op，不会把已经 promoted 的行回退成失败。
// 这两条一旦被破坏，卡死会以另一种形式复发，而且更难从日志看出来。

const SESSION_ID = "session-input-settle";
const BASE_TIME = 1_700_000_000_000;

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runSqliteSessionMigrations(db, ":memory:");
  db.prepare(
    "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(SESSION_ID, "project", "slug", "/tmp/workspace", "会话", "1", BASE_TIME, BASE_TIME);
  return db;
}

function readStatus(db: DatabaseSync, id: string): { status: string; reason: string | null } {
  const row = db
    .prepare("select status, status_reason from session_input where id = ?")
    .get(id) as { status: string; status_reason: string | null };
  return { status: row.status, reason: row.status_reason };
}

test("admitted 行被收口成 failed 并带原因，FIFO 不再被它占住", async () => {
  const db = createDb();
  await saveSessionInput(db, {
    id: "input-1",
    sessionID: SESSION_ID as never,
    kind: "user_message",
    delivery: "queue",
    payload: { text: "帮我看看这个" },
  });
  await saveSessionInput(db, {
    id: "input-2",
    sessionID: SESSION_ID as never,
    kind: "user_message",
    delivery: "queue",
    payload: { text: "在吗" },
  });

  await settleSessionInput(db, {
    id: "input-1",
    sessionID: SESSION_ID as never,
    status: "failed",
    reason: "fault.command.turnLifecycleEscaped",
  });

  const settled = readStatus(db, "input-1");
  assert.equal(settled.status, "failed");
  assert.equal(settled.reason, "fault.command.turnLifecycleEscaped");
  // 后面那条输入仍然是 admitted，说明账本没被这次收口带偏——真正被终结的只有出错那一行。
  assert.equal(readStatus(db, "input-2").status, "admitted");
  db.close();
});

test("已 promoted 的行再被兜底收口是 no-op，不会把成功输入回退成失败", async () => {
  const db = createDb();
  await saveSessionInput(db, {
    id: "input-1",
    sessionID: SESSION_ID as never,
    kind: "user_message",
    delivery: "queue",
    payload: { text: "正常输入" },
  });
  await markSessionInputPromoted(db, {
    id: "input-1",
    sessionID: SESSION_ID as never,
    promotedMessageID: "msg-1",
  });

  // 模拟 turn 正常跑完后 finally 仍然走了一次收口。
  await settleSessionInput(db, {
    id: "input-1",
    sessionID: SESSION_ID as never,
    status: "failed",
    reason: "fault.command.turnLifecycleEscaped",
  });

  const row = db
    .prepare("select status, promoted_message_id, promoted_sequence from session_input where id = ?")
    .get("input-1") as {
    status: string;
    promoted_message_id: string | null;
    promoted_sequence: number | null;
  };
  assert.equal(row.status, "promoted");
  assert.equal(row.promoted_message_id, "msg-1");
  assert.equal(row.promoted_sequence, 0);
  db.close();
});

test("重复收口同一行不再改写状态，保持幂等", async () => {
  const db = createDb();
  await saveSessionInput(db, {
    id: "input-1",
    sessionID: SESSION_ID as never,
    kind: "user_message",
    delivery: "queue",
    payload: { text: "会报错的那条" },
  });

  await settleSessionInput(db, {
    id: "input-1",
    sessionID: SESSION_ID as never,
    status: "failed",
    reason: "fault.command.turnLifecycleEscaped",
  });
  await settleSessionInput(db, {
    id: "input-1",
    sessionID: SESSION_ID as never,
    status: "discarded",
    reason: "后续路径的迟到收口",
  });

  const settled = readStatus(db, "input-1");
  assert.equal(settled.status, "failed");
  assert.equal(settled.reason, "fault.command.turnLifecycleEscaped");
  db.close();
});
