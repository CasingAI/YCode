import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { MessageInfo, MessagePart, SessionId } from "@zcode/contracts";
import { runSqliteSessionMigrations } from "../src/storage/session-store/migration-runner.js";
import {
  markSessionInputPromoted,
  promoteSessionInput,
  saveSessionInput,
  settleSessionInput,
} from "../src/storage/session-store/repositories/session-inputs.js";
import * as sessionEntryRepository from "../src/storage/session-store/repositories/session-entries.js";

// 补投升格的 repository 级不变量：
// 1) promoteSessionInput 刻意不做「仅 admitted」守卫——冷恢复补投要能把历史
//    discarded/failed 行直接升格为 promoted；
// 2) 共享上下文挂不上（entry 缺失/状态不符）不得回滚整笔事务：跳过挂载并上报
//    skippedSharedContextIds，正文照常落库；
// 3) markSessionInputPromoted 允许把非 promoted 历史行补成 promoted（去重路径），
//    但不得覆盖已 promoted 行的既有事实。

const SESSION_ID = "session-input-promote";
const BASE_TIME = 1_700_000_000_000;

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runSqliteSessionMigrations(db, ":memory:");
  db.prepare(
    "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(SESSION_ID, "project", "slug", "/tmp/workspace", "会话", "1", BASE_TIME, BASE_TIME);
  return db;
}

function readStatus(
  db: DatabaseSync,
  id: string,
): { status: string; reason: string | null; promotedMessageId: string | null } {
  const row = db
    .prepare("select status, status_reason, promoted_message_id from session_input where id = ?")
    .get(id) as { status: string; status_reason: string | null; promoted_message_id: string | null };
  return { status: row.status, reason: row.status_reason, promotedMessageId: row.promoted_message_id };
}

function userMessage(id: string, metadata?: Record<string, unknown>): MessageInfo {
  return {
    id,
    sessionID: SESSION_ID as SessionId,
    role: "user",
    time: { created: BASE_TIME },
    semantics: {
      origin: "real_user",
      kind: "user_prompt",
      uiVisibility: "visible",
      providerVisibility: "visible",
      transcriptVisibility: "visible",
    },
    ...(metadata ? { metadata } : {}),
  } as unknown as MessageInfo;
}

function textPart(messageID: string): MessagePart {
  return {
    id: `part-${messageID}`,
    sessionID: SESSION_ID as SessionId,
    messageID: messageID as MessageInfo["id"],
    type: "text",
    text: "补投正文",
    time: { start: BASE_TIME, end: BASE_TIME },
  } as unknown as MessagePart;
}

test("历史 discarded/failed 行可直接升格为 promoted（无「仅 admitted」守卫）", async () => {
  const db = createDb();
  await saveSessionInput(db, {
    id: "input-discarded",
    sessionID: SESSION_ID as SessionId,
    kind: "sendText",
    delivery: "queue",
    payload: { text: "历史丢弃行" },
  });
  await settleSessionInput(db, {
    id: "input-discarded",
    sessionID: SESSION_ID as SessionId,
    status: "discarded",
    reason: "session_resumed",
  });
  await saveSessionInput(db, {
    id: "input-failed",
    sessionID: SESSION_ID as SessionId,
    kind: "sendText",
    delivery: "startNow",
    payload: { text: "历史失败行" },
  });
  await settleSessionInput(db, {
    id: "input-failed",
    sessionID: SESSION_ID as SessionId,
    status: "failed",
    reason: "fault.command.turnLifecycleEscaped",
  });

  await promoteSessionInput(db, {
    id: "input-discarded",
    sessionID: SESSION_ID as SessionId,
    message: userMessage("msg-1"),
    parts: [textPart("msg-1")],
  });
  await promoteSessionInput(db, {
    id: "input-failed",
    sessionID: SESSION_ID as SessionId,
    message: userMessage("msg-2"),
    parts: [textPart("msg-2")],
  });

  assert.equal(readStatus(db, "input-discarded").status, "promoted");
  assert.equal(readStatus(db, "input-failed").status, "promoted");
});

test("共享上下文 entry 缺失：跳过挂载不抛错，正文与 parts 落库并上报 contextId", async () => {
  const db = createDb();
  await saveSessionInput(db, {
    id: "input-shared",
    sessionID: SESSION_ID as SessionId,
    kind: "sendText",
    delivery: "startNow",
    payload: { text: "带共享上下文" },
  });

  const outcome = await promoteSessionInput(db, {
    id: "input-shared",
    sessionID: SESSION_ID as SessionId,
    message: userMessage("msg-shared", {
      inputIntent: {
        sharedContextRefs: [{ kind: "shared_context_import", context_id: "ctx-missing" }],
      },
    }),
    parts: [textPart("msg-shared")],
  });

  assert.deepEqual(outcome.skippedSharedContextIds, ["ctx-missing"]);
  assert.equal(readStatus(db, "input-shared").status, "promoted");
  const messageRow = db
    .prepare("select data from message where id = ?")
    .get("msg-shared") as { data: string } | undefined;
  assert.ok(messageRow, "正文消息必须照常落库");
});

test("共享上下文状态不可挂上（attached）：同样跳过并上报", async () => {
  const db = createDb();
  await saveSessionInput(db, {
    id: "input-shared-2",
    sessionID: SESSION_ID as SessionId,
    kind: "sendText",
    delivery: "startNow",
    payload: { text: "已被附着的导入" },
  });
  const now = Date.now();
  await sessionEntryRepository.saveSessionEntry(db, {
    id: "entry-ctx-attached",
    sessionID: SESSION_ID as SessionId,
    type: "v4/shared_context_import",
    time: { created: now, updated: now },
    data: { contextId: "ctx-attached", status: "attached" },
  });

  const outcome = await promoteSessionInput(db, {
    id: "input-shared-2",
    sessionID: SESSION_ID as SessionId,
    message: userMessage("msg-shared-2", {
      inputIntent: {
        sharedContextRefs: [{ kind: "shared_context_import", context_id: "ctx-attached" }],
      },
    }),
    parts: [textPart("msg-shared-2")],
  });

  assert.deepEqual(outcome.skippedSharedContextIds, ["ctx-attached"]);
  assert.equal(readStatus(db, "input-shared-2").status, "promoted");
});

test("共享上下文可正常挂上：entry 转 attached，不上报跳过", async () => {
  const db = createDb();
  await saveSessionInput(db, {
    id: "input-shared-3",
    sessionID: SESSION_ID as SessionId,
    kind: "sendText",
    delivery: "startNow",
    payload: { text: "可挂上的导入" },
  });
  const now = Date.now();
  await sessionEntryRepository.saveSessionEntry(db, {
    id: "entry-ctx-pending",
    sessionID: SESSION_ID as SessionId,
    type: "v4/shared_context_import",
    time: { created: now, updated: now },
    data: { contextId: "ctx-pending", status: "pending" },
  });

  const outcome = await promoteSessionInput(db, {
    id: "input-shared-3",
    sessionID: SESSION_ID as SessionId,
    message: userMessage("msg-shared-3", {
      inputIntent: {
        sharedContextRefs: [{ kind: "shared_context_import", context_id: "ctx-pending" }],
      },
    }),
    parts: [textPart("msg-shared-3")],
  });

  assert.deepEqual(outcome.skippedSharedContextIds, []);
  const entry = (
    await sessionEntryRepository.sessionEntries(db, {
      sessionID: SESSION_ID as SessionId,
      type: "v4/shared_context_import",
    })
  ).find((candidate) => (candidate.data as Record<string, unknown>).contextId === "ctx-pending");
  assert.equal((entry?.data as Record<string, unknown> | undefined)?.status, "attached");
});

test("markSessionInputPromoted：非 promoted 历史行可补账本，已 promoted 行不覆盖", async () => {
  const db = createDb();
  await saveSessionInput(db, {
    id: "input-dup",
    sessionID: SESSION_ID as SessionId,
    kind: "sendText",
    delivery: "queue",
    payload: { text: "去重补账本" },
  });
  await settleSessionInput(db, {
    id: "input-dup",
    sessionID: SESSION_ID as SessionId,
    status: "discarded",
    reason: "session_resumed",
  });
  await markSessionInputPromoted(db, {
    id: "input-dup",
    sessionID: SESSION_ID as SessionId,
    promotedMessageID: "msg-existing" as MessageInfo["id"],
  });
  assert.equal(readStatus(db, "input-dup").status, "promoted");
  assert.equal(readStatus(db, "input-dup").promotedMessageId, "msg-existing");

  // 再跑一次不得改写既有的 promoted_message_id。
  await markSessionInputPromoted(db, {
    id: "input-dup",
    sessionID: SESSION_ID as SessionId,
    promotedMessageID: "msg-other" as MessageInfo["id"],
  });
  assert.equal(readStatus(db, "input-dup").promotedMessageId, "msg-existing");
});
