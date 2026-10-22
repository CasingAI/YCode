import assert from "node:assert/strict";
import test from "node:test";
import {
  createComposerDraftService,
  createMemoryComposerDraftStore,
} from "@zcode/services";
import {
  configureSharedComposerDraft,
  getSharedComposerDraftClientId,
  readSharedComposerDraft,
  removeSharedComposerDraft,
  subscribeSharedComposerDraft,
  writeSharedComposerDraft,
} from "../src/v4/composer/sharedComposerDraft.js";
import { shouldApplySharedComposerDraft } from "../src/v4/composer/useSharedComposerDraftSync.js";

function createService() {
  let now = 1000;
  return createComposerDraftService({
    store: createMemoryComposerDraftStore(),
    now: () => (now += 1),
  });
}

test("共享草稿服务：写入后能读回同一条记录", async () => {
  const service = createService();
  await service.putDraft({
    workspaceKey: "/repo/alpha",
    scopeId: "session-1",
    payload: { text: "hello" },
    clientId: "client-a",
  });

  const record = await service.getDraft({
    workspaceKey: "/repo/alpha",
    scopeId: "session-1",
  });
  assert.equal(record?.payload !== undefined, true);
  assert.deepEqual(record?.payload, { text: "hello" });
  assert.equal(record?.clientId, "client-a");
});

test("共享草稿服务：清除后读不到记录", async () => {
  const service = createService();
  await service.putDraft({
    workspaceKey: "/repo/alpha",
    scopeId: "session-1",
    payload: { text: "hello" },
    clientId: "client-a",
  });
  await service.clearDraft({ workspaceKey: "/repo/alpha", scopeId: "session-1" });

  const record = await service.getDraft({
    workspaceKey: "/repo/alpha",
    scopeId: "session-1",
  });
  assert.equal(record, null);
});

test("共享草稿服务：写入会广播变更，清除广播空记录", async () => {
  const service = createService();
  const changes: Array<string | null> = [];
  service.onDidChangeDraft((change) => {
    changes.push(change.record ? "written" : "cleared");
  });

  await service.putDraft({
    workspaceKey: "/repo/alpha",
    scopeId: "session-1",
    payload: { text: "hello" },
    clientId: "client-a",
  });
  await service.clearDraft({ workspaceKey: "/repo/alpha", scopeId: "session-1" });

  assert.deepEqual(changes, ["written", "cleared"]);
});

test("共享草稿客户端：绑定服务后写入与读取走同一份存储", async () => {
  const service = createService();
  configureSharedComposerDraft(service);
  try {
    writeSharedComposerDraft("/repo/alpha", "session-1", { text: "shared" });
    // 写入是异步的；等一次事件循环让 putDraft 落定。
    await new Promise((resolve) => setTimeout(resolve, 0));

    const record = await readSharedComposerDraft("/repo/alpha", "session-1");
    assert.deepEqual(record?.payload, { text: "shared" });
    assert.equal(record?.clientId, getSharedComposerDraftClientId());
  } finally {
    configureSharedComposerDraft(null);
  }
});

test("共享草稿客户端：订阅者能收到另一端的写入", async () => {
  const service = createService();
  configureSharedComposerDraft(service);
  try {
    const seen: string[] = [];
    const unsubscribe = subscribeSharedComposerDraft((change) => {
      if (change.record) {
        seen.push(String((change.record.payload as { text?: string }).text));
      }
    });

    await service.putDraft({
      workspaceKey: "/repo/alpha",
      scopeId: "session-1",
      payload: { text: "from-other-end" },
      clientId: "other-client",
    });
    unsubscribe();

    assert.deepEqual(seen, ["from-other-end"]);
  } finally {
    configureSharedComposerDraft(null);
  }
});

test("共享草稿客户端：清除共享草稿后读不到记录", async () => {
  const service = createService();
  configureSharedComposerDraft(service);
  try {
    writeSharedComposerDraft("/repo/alpha", "session-1", { text: "shared" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    removeSharedComposerDraft("/repo/alpha", "session-1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const record = await readSharedComposerDraft("/repo/alpha", "session-1");
    assert.equal(record, null);
  } finally {
    configureSharedComposerDraft(null);
  }
});

test("覆盖裁决：自己写的记录不应用", () => {
  const localClientId = "client-a";
  assert.equal(
    shouldApplySharedComposerDraft({
      record: {
        workspaceKey: "/repo/alpha",
        scopeId: "session-1",
        payload: { text: "mine" },
        updatedAt: 10,
        clientId: localClientId,
      },
      localClientId,
      seenText: "",
      editorClean: true,
    }),
    false,
  );
});

test("覆盖裁决：正文相同不应用，避免写入回环", () => {
  assert.equal(
    shouldApplySharedComposerDraft({
      record: {
        workspaceKey: "/repo/alpha",
        scopeId: "session-1",
        payload: { text: "same" },
        updatedAt: 10,
        clientId: "other-client",
      },
      localClientId: "client-a",
      seenText: "same",
      editorClean: true,
    }),
    false,
  );
});

test("覆盖裁决：本地还有未保存输入时不应用", () => {
  assert.equal(
    shouldApplySharedComposerDraft({
      record: {
        workspaceKey: "/repo/alpha",
        scopeId: "session-1",
        payload: { text: "remote" },
        updatedAt: 10,
        clientId: "other-client",
      },
      localClientId: "client-a",
      seenText: "local",
      editorClean: false,
    }),
    false,
  );
});

test("覆盖裁决：另一端的正文且本地干净时应用", () => {
  assert.equal(
    shouldApplySharedComposerDraft({
      record: {
        workspaceKey: "/repo/alpha",
        scopeId: "session-1",
        payload: { text: "remote" },
        updatedAt: 10,
        clientId: "other-client",
      },
      localClientId: "client-a",
      seenText: "local",
      editorClean: true,
    }),
    true,
  );
});
