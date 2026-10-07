// 会话模型组状态 entry（runtime/model_group）的持久化形状与读侧容错测试。
//
// Fork 拷贝的核心语义（docs/specs/model-group.md）：子会话拿到的是「意图 + 名快照 +
// 种子」的原样 JSON；读侧不自行哈希、不校验组存在性——失效在发送 admission 裁决。
// 这里锁住 entry 的读法：最新一条生效、坏数据整条丢弃、意图与种子至少其一。
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntryInfo, SessionStorePort } from "@zcode/contracts";
import { SESSION_ENTRY_MODEL_GROUP } from "@zcode/contracts";
import { readSessionModelGroupState } from "../src/runtime/methods/session-model-group.js";

function storeWithEntries(entries: readonly SessionEntryInfo[]): SessionStorePort {
  return {
    async sessionEntries({ type }: { type: string }) {
      return entries.filter((entry) => entry.type === type);
    },
  } as unknown as SessionStorePort;
}

function groupEntry(data: unknown): SessionEntryInfo {
  const timestamp = Date.now();
  return {
    id: "sess-1:runtime-model-group",
    sessionID: "sess-1",
    type: SESSION_ENTRY_MODEL_GROUP,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data,
  } as SessionEntryInfo;
}

const INTENT = { groupId: "model-group:demo", groupNameSnapshot: "演示组" };

test("读回意图与种子：fork 拷贝的 JSON 原样还原", async () => {
  const store = storeWithEntries([
    groupEntry({ intent: INTENT, pickSeed: "parent-seed" }),
  ]);
  const state = await readSessionModelGroupState(store, "sess-1");
  assert.deepEqual(state, { intent: INTENT, pickSeed: "parent-seed" });
});

test("多条 entry 取最新一条", async () => {
  const store = storeWithEntries([
    groupEntry({ intent: INTENT, pickSeed: "old-seed" }),
    groupEntry({ intent: INTENT, pickSeed: "new-seed" }),
  ]);
  const state = await readSessionModelGroupState(store, "sess-1");
  assert.equal(state?.pickSeed, "new-seed");
});

test("只带种子（意图缺省）也还原；两者皆无视为无状态", async () => {
  const seedOnly = await readSessionModelGroupState(
    storeWithEntries([groupEntry({ pickSeed: "seed" })]),
    "sess-1",
  );
  assert.deepEqual(seedOnly, { intent: null, pickSeed: "seed" });
  const empty = await readSessionModelGroupState(
    storeWithEntries([groupEntry({ intent: INTENT })]),
    "sess-1",
  );
  assert.deepEqual(empty, { intent: INTENT, pickSeed: null });
});

test("坏数据整条丢弃：不抛错、不返回半截状态", async () => {
  const broken = await readSessionModelGroupState(
    storeWithEntries([groupEntry({ intent: { groupId: "" }, pickSeed: 42 })]),
    "sess-1",
  );
  assert.equal(broken, undefined);
  const none = await readSessionModelGroupState(storeWithEntries([]), "sess-1");
  assert.equal(none, undefined);
});
