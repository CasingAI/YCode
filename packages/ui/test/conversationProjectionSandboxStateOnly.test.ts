import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationSnapshot,
  ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { conversationTopic } from "@zcode/shared/zcode-protocol-v4";
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import type { ConversationTransport } from "@/v4/transport.js";

const SESSION_ID = "sess-sandbox-state-only";
const TOPIC = conversationTopic(SESSION_ID);

function makeSnapshot(seq: number, sandbox: { revision: number; alive: boolean | null }): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: SESSION_ID,
    logEpoch: "epoch-1",
    seq,
    revision: 1,
    sandbox,
    rows: { window: [], totalCount: 0, firstRowId: null },
    queue: { items: [] },
    modelTransition: null,
  } as unknown as ConversationSnapshot;
}

async function createStore(): Promise<{
  store: ConversationProjectionStore;
  deliver: (frame: ConversationTopicFrame) => void;
}> {
  const transport = {
    subscribe: async () => ({
      ack: { subscriptionId: "sub-1", logEpoch: "epoch-1", mode: "snapshot" },
    }),
    activate: () => {},
    unsubscribe: async () => {},
    resync: async () => ({ frames: [] }),
    rowsRange: async () => ({ rows: [], atSeq: 1, atRevision: 1, atLogEpoch: "epoch-1" }),
    onFrame: () => () => {},
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
  } as unknown as ConversationTransport;
  const store = new ConversationProjectionStore(TOPIC, transport);
  await store.connect();
  return {
    store,
    deliver: (frame) => store.handleFrame(frame),
  };
}

function stateOnlyFrame(seq: number, sandbox: { revision: number; alive: boolean | null }): ConversationTopicFrame {
  return {
    topic: TOPIC,
    subscriptionId: "sub-1",
    fromSeq: seq,
    toSeq: seq,
    sentAt: 1_000,
    payload: { kind: "deltas", deltas: [{ op: "state.updated", patch: { sandbox } }] },
  } as unknown as ConversationTopicFrame;
}

// 缺陷二回归：已追平客户端（本地 seq=N）在无后续事件时，
// 必须能收到 (N,N] 零宽度 state-only 帧的状态变更。
test("state-only 帧：已追平客户端能收到 sandbox 状态变更，seq 水位不动", async () => {
  const { store, deliver } = await createStore();
  const initial = makeSnapshot(7, { revision: 1, alive: null });
  deliver({ ...stateOnlyFrame(0, { revision: 1, alive: null }), payload: { kind: "snapshot", snapshot: initial } } as unknown as ConversationTopicFrame);

  deliver(stateOnlyFrame(7, { revision: 2, alive: true }));

  const snapshot = (await store.getState()).snapshot;
  assert.deepEqual(snapshot?.sandbox, { revision: 2, alive: true });
  assert.equal(snapshot?.seq, 7);
});

test("state-only 帧：重复/陈旧投递不回退已更新的状态", async () => {
  const { store, deliver } = await createStore();
  const initial = makeSnapshot(7, { revision: 1, alive: null });
  deliver({ ...stateOnlyFrame(0, { revision: 1, alive: null }), payload: { kind: "snapshot", snapshot: initial } } as unknown as ConversationTopicFrame);

  deliver(stateOnlyFrame(7, { revision: 2, alive: true }));
  // 陈旧重放：revision 1 的旧补丁迟到，不得把 alive=true 回退。
  deliver(stateOnlyFrame(7, { revision: 1, alive: null }));

  assert.deepEqual((await store.getState()).snapshot?.sandbox, { revision: 2, alive: true });
});

test("非 state-only 零宽度帧仍按旧规则丢弃", async () => {
  const { store, deliver } = await createStore();
  const initial = makeSnapshot(7, { revision: 1, alive: null });
  deliver({ ...stateOnlyFrame(0, { revision: 1, alive: null }), payload: { kind: "snapshot", snapshot: initial } } as unknown as ConversationTopicFrame);

  // 混入行 delta 的零宽度帧不走 state-only 分支：整帧丢弃，快照不动。
  deliver({
    topic: TOPIC,
    subscriptionId: "sub-1",
    fromSeq: 7,
    toSeq: 7,
    sentAt: 1_000,
    payload: {
      kind: "deltas",
      deltas: [
        { op: "state.updated", patch: { sandbox: { revision: 2, alive: true } } },
        { op: "row.delta", rowId: 1, path: "text", append: "x" },
      ],
    },
  } as unknown as ConversationTopicFrame);

  assert.deepEqual((await store.getState()).snapshot?.sandbox, { revision: 1, alive: null });
});
