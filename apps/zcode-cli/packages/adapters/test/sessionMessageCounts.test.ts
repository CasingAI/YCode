import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { SessionId } from "@zcode/contracts";
import { runSqliteSessionMigrations } from "../src/storage/session-store/migration-runner.js";
import { saveMessage, sessionMessageCounts } from "../src/storage/session-store/repositories/messages.js";

// HistoryList 的消息数列走 sessionMessageCounts（session-store.port 可选方法）。
// 语义边界：未知 id 静默缺席（不伪造 0）、重复 id 去重、空输入返回空对象。

const BASE_TIME = 1_700_000_000_000;

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runSqliteSessionMigrations(db, ":memory:");
  return db;
}

async function createSessionWithMessages(
  db: DatabaseSync,
  sessionID: string,
  messageCount: number,
): Promise<void> {
  db.prepare(
    "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(sessionID, "project", sessionID, "/tmp/workspace", "会话", "1", BASE_TIME, BASE_TIME);
  for (let i = 0; i < messageCount; i++) {
    await saveMessage(db, {
      id: `${sessionID}-msg-${i}`,
      sessionID: sessionID as SessionId,
      role: "user",
      time: { created: BASE_TIME + i },
    });
  }
}

test("sessionMessageCounts：按会话分组返回消息总数", async () => {
  const db = createDb();
  try {
    await createSessionWithMessages(db, "sess_a", 3);
    await createSessionWithMessages(db, "sess_b", 1);

    const counts = sessionMessageCounts(db, { sessionIDs: ["sess_a", "sess_b"] as SessionId[] });
    assert.deepEqual(counts, { sess_a: 3, sess_b: 1 });
  } finally {
    db.close();
  }
});

test("sessionMessageCounts：未知 id 缺席、重复 id 去重、空输入为空对象", async () => {
  const db = createDb();
  try {
    await createSessionWithMessages(db, "sess_a", 2);

    const missing = sessionMessageCounts(db, { sessionIDs: ["sess_missing"] as SessionId[] });
    assert.deepEqual(missing, {});

    const deduped = sessionMessageCounts(db, {
      sessionIDs: ["sess_a", "sess_a", "sess_missing"] as SessionId[],
    });
    assert.deepEqual(deduped, { sess_a: 2 });

    assert.deepEqual(sessionMessageCounts(db, { sessionIDs: [] }), {});
  } finally {
    db.close();
  }
});
