import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runSqliteSessionMigrations } from "../src/storage/session-store/migration-runner.js";
import { savePart } from "../src/storage/session-store/repositories/messages.js";

// 流中占位保序（streaming-pipelined-tool-execution spec）依赖 part.sequence 的两条语义：
// 1. INSERT 时现场 max+1——先写者得小号；
// 2. 同 id、同 message 更新保留原 sequence——回填不会把正文重新排到工具后面。
// 这两条一旦漂移，工具行就会在落库里抢占正文序号，冷恢复回放顺序直接反过来。

const SESSION_ID = "session-placeholder";
const MESSAGE_ID = "message-placeholder";
const BASE_TIME = 1_700_000_000_000;

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // 走生产迁移入口：schema_migration 账本与 sequence 列都由它负责。
  runSqliteSessionMigrations(db, ":memory:");
  db.prepare(
    "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(SESSION_ID, "project", "slug", "/tmp/workspace", "会话", "1", BASE_TIME, BASE_TIME);
  db.prepare(
    "insert into message (id, session_id, data, time_created, time_updated) values (?, ?, ?, ?, ?)",
  ).run(MESSAGE_ID, SESSION_ID, "{}", BASE_TIME, BASE_TIME);
  return db;
}

interface PlaceInput {
  id: string;
  type: "reasoning" | "text" | "tool";
  text?: string;
  state?: "pending" | "running" | "completed";
}

async function save(db: DatabaseSync, input: PlaceInput): Promise<void> {
  const base = {
    id: input.id,
    sessionID: SESSION_ID,
    messageID: MESSAGE_ID,
    type: input.type,
  };
  if (input.type === "text") {
    await savePart(db, { ...base, type: "text", text: input.text ?? "" });
    return;
  }
  if (input.type === "reasoning") {
    await savePart(db, {
      ...base,
      type: "reasoning",
      text: input.text ?? "",
      time: { start: BASE_TIME },
    });
    return;
  }
  await savePart(db, {
    ...base,
    type: "tool",
    callID: `call-${input.id}`,
    tool: "CreatePlan",
    state: {
      status: input.state ?? "pending",
      input: {},
      title: "CreatePlan",
      time: { start: BASE_TIME },
    },
  });
}

function sequenceOf(db: DatabaseSync, id: string): number {
  const row = db.prepare("select sequence from part where id = ?").get(id) as
    | { sequence: number | null }
    | undefined;
  assert.ok(row, `part ${id} 应存在`);
  assert.equal(typeof row.sequence, "number", `part ${id} 应有 sequence`);
  return row.sequence;
}

function partIdsBySequence(db: DatabaseSync): string[] {
  const rows = db
    .prepare("select id from part where message_id = ? order by sequence, time_created, id")
    .all(MESSAGE_ID) as { id: string }[];
  return rows.map((row) => row.id);
}

function textOf(db: DatabaseSync, id: string): string | undefined {
  const row = db.prepare("select data from part where id = ?").get(id) as
    | { data: string }
    | undefined;
  assert.ok(row, `part ${id} 应存在`);
  return (JSON.parse(row.data) as { text?: string }).text;
}

test("同 id 更新保留原 sequence：流末回填不会把正文排到工具后面", async () => {
  const db = createDb();
  try {
    // 步起点占位 → 流中工具 → 流末回填，与 turn-model-step 的真实写入顺序一致。
    await save(db, { id: "part-reasoning-placeholder", type: "reasoning" });
    await save(db, { id: "part-text-placeholder", type: "text" });
    await save(db, { id: "part-tool", type: "tool", state: "completed" });
    const placeholderSequence = sequenceOf(db, "part-text-placeholder");

    await save(db, { id: "part-text-placeholder", type: "text", text: "计划写好了" });

    assert.equal(
      sequenceOf(db, "part-text-placeholder"),
      placeholderSequence,
      "回填必须沿用步起点占住的序号",
    );
    assert.ok(
      sequenceOf(db, "part-text-placeholder") < sequenceOf(db, "part-tool"),
      "正文序号必须小于工具序号",
    );
    assert.deepEqual(partIdsBySequence(db), [
      "part-reasoning-placeholder",
      "part-text-placeholder",
      "part-tool",
    ]);
    assert.equal(
      textOf(db, "part-text-placeholder"),
      "计划写好了",
      "回填内容必须覆盖空占位，PART_DATA_UPDATE 只保留 fromModel/toModel/model",
    );
  } finally {
    db.close();
  }
});

test("工具 part 的 pending → running 改写同样不改号", async () => {
  const db = createDb();
  try {
    await save(db, { id: "part-text-placeholder", type: "text" });
    await save(db, { id: "part-tool", type: "tool", state: "pending" });
    await save(db, { id: "part-tool", type: "tool", state: "running" });

    assert.ok(
      sequenceOf(db, "part-text-placeholder") < sequenceOf(db, "part-tool"),
      "工具在流中改写状态不得跳到正文前面",
    );
    assert.deepEqual(partIdsBySequence(db), ["part-text-placeholder", "part-tool"]);
  } finally {
    db.close();
  }
});

test("没有回填的占位保留原位，不影响后写入的工具序号", async () => {
  const db = createDb();
  try {
    await save(db, { id: "part-reasoning-placeholder", type: "reasoning" });
    await save(db, { id: "part-text-placeholder", type: "text" });
    await save(db, { id: "part-tool", type: "tool", state: "completed" });
    // Stop / 断流路径不额外写行；空占位就是库里留着的两行空行。

    assert.deepEqual(partIdsBySequence(db), [
      "part-reasoning-placeholder",
      "part-text-placeholder",
      "part-tool",
    ]);
  } finally {
    db.close();
  }
});
