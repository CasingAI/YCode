import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HISTORY_READ_LANE_WORKER_BUNDLE_NAME } from "../src/storage/session-store/history-read-lane-worker-url.js";
import {
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  type CreateSessionInput,
  type IsolatedHistoryJob,
  type SessionId,
  type UserMessageInfo,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";
import { createHistoryReadLane } from "../src/storage/session-store/history-read-lane.js";

const NOW = Date.now();

async function withFileStore(
  run: (store: ReturnType<typeof createSqliteSessionStore>, dbPath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-history-lane-"));
  const dbPath = join(dir, "session.db");
  const store = createSqliteSessionStore({ dbPath });
  try {
    await run(store, dbPath);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function sessionInput(id: SessionId, title: string): CreateSessionInput {
  return {
    id,
    projectID: createProjectId(),
    taskType: "interactive",
    slug: id,
    directory: "/workspace/demo",
    title,
    version: "0.0.0-test",
    time: { created: NOW, updated: NOW },
  };
}

async function seedTurn(
  store: ReturnType<typeof createSqliteSessionStore>,
  sessionID: SessionId,
  text: string,
): Promise<void> {
  const messageID = createMessageId();
  await store.saveMessage({
    id: messageID,
    sessionID,
    role: "user",
    time: { created: NOW },
    agent: "test",
    semantics: {
      origin: "real_user",
      kind: "user_prompt",
      uiVisibility: "visible",
      providerVisibility: "visible",
      transcriptVisibility: "visible",
    },
  } as UserMessageInfo);
  await store.savePart({
    id: createPartId(),
    sessionID,
    messageID,
    type: "text",
    text,
  });
}

test("SqliteSessionStore 旁路：Search 命中与 Read 段号一致，List 带消息数", async () => {
  await withFileStore(async (store) => {
    const sessionId = createSessionId("hist_main");
    await store.createSession(sessionInput(sessionId, "主会话"));
    await seedTurn(store, sessionId, "讨论 root cause 与修复方案");

    const search = await store.runIsolatedHistoryJob({
      kind: "search",
      input: { query: "root cause" },
    });
    assert.equal(search.kind, "search");
    assert.equal(search.output.status, "success");
    assert.equal(search.output.hits.length, 1);
    assert.equal(search.output.hits[0]?.sessionId, sessionId);
    assert.equal(search.output.hits[0]?.segment, 1);

    const read = await store.runIsolatedHistoryJob({
      kind: "read",
      input: { sessionId, fromSegment: 1 },
      currentSessionId: sessionId,
    });
    assert.equal(read.kind, "read");
    assert.equal(read.output.status, "success");
    assert.ok(read.output.content.includes("root cause"));

    const list = await store.runIsolatedHistoryJob({ kind: "list", input: { days: 7 } });
    assert.equal(list.kind, "list");
    assert.equal(list.output.sessions.length, 1);
    assert.equal(list.output.sessions[0]?.messageCount, 1);
  });
});

test("SqliteSessionStore 旁路：三次并行 Search 实际串行", async () => {
  await withFileStore(async (store, dbPath) => {
    const sessionId = createSessionId("hist_parallel");
    await store.createSession(sessionInput(sessionId, "并行"));
    await seedTurn(store, sessionId, "root cause");
    const lane = createHistoryReadLane({ dbPath });
    const job: IsolatedHistoryJob = { kind: "search", input: { query: "root cause" } };
    try {
      const results = await Promise.all([lane.enqueue(job), lane.enqueue(job), lane.enqueue(job)]);
      assert.equal(lane.stats.maxObservedActive, 1);
      assert.ok(results.every((result) => result.kind === "search" && result.output.hits.length === 1));
    } finally {
      lane.dispose();
    }
  });
});

test("SqliteSessionStore 旁路：Search 期间主连接仍能读写", async () => {
  await withFileStore(async (store) => {
    const sessionId = createSessionId("hist_live");
    await store.createSession(sessionInput(sessionId, "主连接"));
    for (let i = 0; i < 20; i++) {
      await seedTurn(store, sessionId, `root cause 样本 ${i} ${"x".repeat(200)}`);
    }
    const search = store.runIsolatedHistoryJob({
      kind: "search",
      input: { query: "root cause" },
    });
    const started = Date.now();
    const existing = await store.getSession(sessionId);
    const readMs = Date.now() - started;
    assert.ok(existing, "主连接读会话必须立刻返回");
    assert.ok(readMs < 500, `主连接 getSession 被旁路堵住了（${readMs}ms）`);
    await seedTurn(store, sessionId, "主连接写入仍可用");
    const result = await search;
    assert.equal(result.kind, "search");
    assert.equal(result.output.status, "success");
  });
});

test("SqliteSessionStore 旁路：abort 后 worker 退出且后续作业仍可用", async () => {
  await withFileStore(async (store) => {
    const sessionId = createSessionId("hist_abort");
    await store.createSession(sessionInput(sessionId, "取消"));
    await seedTurn(store, sessionId, "root cause");
    const controller = new AbortController();
    const pending = store.runIsolatedHistoryJob(
      { kind: "search", input: { query: "root cause" } },
      { signal: controller.signal },
    );
    controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    const list = await store.runIsolatedHistoryJob({ kind: "list", input: {} });
    assert.equal(list.kind, "list");
    assert.equal(list.output.status, "success");
  });
});

test("SqliteSessionStore 旁路：只读打开不增加 schema_migrations", async () => {
  await withFileStore(async (store) => {
    const before = store.debugCounts();
    const sessionId = createSessionId("hist_migrate");
    await store.createSession(sessionInput(sessionId, "迁移"));
    await seedTurn(store, sessionId, "hello");
    await store.runIsolatedHistoryJob({ kind: "list", input: {} });
    const after = store.debugCounts();
    assert.equal(after.schemaMigrations, before.schemaMigrations);
  });
});

test("CJS 单文件工作线程能跑 List（桌面 zcode.cjs sibling）", async () => {
  const workerPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../cli/dist",
    HISTORY_READ_LANE_WORKER_BUNDLE_NAME,
  );
  assert.equal(existsSync(workerPath), true, `missing bundled worker: ${workerPath}`);
  await withFileStore(async (store, dbPath) => {
    const sessionId = createSessionId("hist_cjs");
    await store.createSession(sessionInput(sessionId, "CJS 工作线程"));
    await seedTurn(store, sessionId, "cjs worker list");
    const lane = createHistoryReadLane({
      dbPath,
      workerUrl: pathToFileURL(workerPath),
    });
    try {
      const result = await lane.enqueue({ kind: "list", input: { days: 7 } });
      assert.equal(result.kind, "list");
      assert.equal(result.output.status, "success");
      assert.equal(result.output.sessions.length, 1);
    } finally {
      lane.dispose();
    }
  });
});

test("SqliteSessionStore：内存库不走旁路但仍能查询", async () => {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  try {
    const sessionId = createSessionId("hist_mem");
    await store.createSession(sessionInput(sessionId, "内存"));
    await seedTurn(store, sessionId, "root cause 内存");
    const search = await store.runIsolatedHistoryJob({
      kind: "search",
      input: { query: "root cause" },
    });
    assert.equal(search.kind, "search");
    assert.equal(search.output.hits.length, 1);
  } finally {
    store.close();
  }
});
