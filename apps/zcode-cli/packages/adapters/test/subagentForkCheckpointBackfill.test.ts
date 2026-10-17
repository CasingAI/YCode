import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  type CreateSessionInput,
  type SubagentIdentityBinding,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";

async function withStore(
  run: (store: ReturnType<typeof createSqliteSessionStore>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-subagent-backfill-"));
  const store = createSqliteSessionStore({ dbPath: join(dir, "session.db") });
  try {
    await run(store);
  } finally {
    store.close?.();
    await rm(dir, { recursive: true, force: true });
  }
}

function childInput(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    id: createSessionId(),
    projectID: createProjectId(),
    taskType: "subagent_child",
    slug: "subagent",
    directory: "/workspace/demo",
    path: "/workspace/demo",
    title: "child",
    version: "0.0.0-test",
    ...overrides,
  };
}

function binding(
  agentId: string,
  childSessionId: string,
): SubagentIdentityBinding {
  return {
    agentId,
    childSessionId,
    agentType: "general-purpose",
    profile: { name: "demo", description: "d", systemPrompt: "p", source: "built-in" },
    workspaceRoot: "/workspace/demo",
    contextResetGeneration: 0,
  };
}

async function createParent(store: ReturnType<typeof createSqliteSessionStore>) {
  return store.createSession({
    id: createSessionId(),
    projectID: createProjectId(),
    slug: "parent",
    directory: "/workspace/demo",
    title: "parent",
    version: "0.0.0-test",
  });
}

async function saveUserMessage(
  store: ReturnType<typeof createSqliteSessionStore>,
  input: {
    sessionID: string;
    id: string;
    created: number;
    text: string;
    anchor?: { origin: string; sourceCommandId: string };
  },
): Promise<void> {
  await store.saveMessage({
    id: input.id,
    sessionID: input.sessionID,
    role: "user",
    time: { created: input.created },
    text: input.text,
    semantics: {
      origin: input.anchor ? "real_user" : "system",
      kind: "user_prompt",
      uiVisibility: "visible",
      providerVisibility: "visible",
      transcriptVisibility: "visible",
    },
    ...(input.anchor ? { anchor: input.anchor } : {}),
  } as never);
  await store.savePart({
    id: createPartId(),
    sessionID: input.sessionID,
    messageID: input.id,
    type: "text",
    text: input.text,
  } as never);
}

async function saveAssistantMessage(
  store: ReturnType<typeof createSqliteSessionStore>,
  input: {
    sessionID: string;
    id: string;
    created: number;
    completed?: number;
  },
): Promise<void> {
  await store.saveMessage({
    id: input.id,
    sessionID: input.sessionID,
    role: "assistant",
    time: { created: input.created, completed: input.completed ?? input.created },
    parentID: input.id,
    mode: "readonly",
    agent: "zcode-agent",
    path: { cwd: "/workspace/demo", root: "/workspace/demo" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "completed",
    semantics: {
      origin: "system",
      kind: "timeline_event",
      uiVisibility: "visible",
      providerVisibility: "hidden",
      transcriptVisibility: "visible",
    },
  } as never);
}

test("边界前创建且缺检查点的 child 按首条 user prompt 前缀回填，Fork 图不再失败", async () => {
  await withStore(async (store) => {
    const parent = await createParent(store);
    const parentPromptId = createMessageId();
    await saveUserMessage(store, {
      sessionID: String(parent.id),
      id: String(parentPromptId),
      created: 100,
      text: "start",
      anchor: { origin: "realUser", sourceCommandId: "parent-input" },
    });
    const boundaryId = createMessageId();
    await saveAssistantMessage(store, {
      sessionID: String(parent.id),
      id: String(boundaryId),
      created: 200,
      completed: 250,
    });

    const childId = createSessionId();
    await store.createSubagentChildSession(
      childInput({ id: childId, parentID: parent.id, time: { created: 150, updated: 150 } }),
      binding("agent_backfill", String(childId)),
    );
    const initId = createMessageId();
    const promptId = createMessageId();
    const answerId = createMessageId();
    await saveAssistantMessage(store, {
      sessionID: String(childId),
      id: String(initId),
      created: 151,
    });
    await saveUserMessage(store, {
      sessionID: String(childId),
      id: String(promptId),
      created: 152,
      text: "delegated task",
      anchor: { origin: "realUser", sourceCommandId: "spawn" },
    });
    await saveAssistantMessage(store, {
      sessionID: String(childId),
      id: String(answerId),
      created: 160,
    });

    // 边界之后创建、没有任何检查点和消息的 child 不得阻断更早历史的 Fork。
    const laterChildId = createSessionId();
    await store.createSubagentChildSession(
      childInput({ id: laterChildId, parentID: parent.id, time: { created: 400, updated: 400 } }),
      binding("agent_after_boundary", String(laterChildId)),
    );

    const graph = await store.resolveSubagentForkCheckpointGraph({
      parentSessionId: String(parent.id),
      boundaryMessageId: String(boundaryId),
    });
    assert.deepEqual(
      graph.children.map((node) => node.checkpoint.agentId),
      ["agent_backfill"],
    );
    // 快照是边界时刻可证明的 child 前缀，不包含之后的执行历史。
    assert.deepEqual(
      graph.children[0]?.history.map((message) => String(message.info.id)),
      [String(initId), String(promptId)],
    );
    assert.equal(graph.children[0]?.checkpoint.boundaryMessageId, String(parentPromptId));

    // 重复解析复用同一不可变检查点。
    const second = await store.resolveSubagentForkCheckpointGraph({
      parentSessionId: String(parent.id),
      boundaryMessageId: String(boundaryId),
    });
    assert.equal(second.children.length, 1);
    assert.deepEqual(
      second.children[0]?.history.map((message) => String(message.info.id)),
      [String(initId), String(promptId)],
    );
  });
});

test("边界前创建但缺少 realUser prompt 的 child 仍按证据不足失败", async () => {
  await withStore(async (store) => {
    const parent = await createParent(store);
    await saveUserMessage(store, {
      sessionID: String(parent.id),
      id: String(createMessageId()),
      created: 100,
      text: "start",
      anchor: { origin: "realUser", sourceCommandId: "parent-input" },
    });
    const boundaryId = createMessageId();
    await saveAssistantMessage(store, {
      sessionID: String(parent.id),
      id: String(boundaryId),
      created: 200,
      completed: 250,
    });
    const childId = createSessionId();
    await store.createSubagentChildSession(
      childInput({ id: childId, parentID: parent.id, time: { created: 150, updated: 150 } }),
      binding("agent_no_prompt", String(childId)),
    );
    // 只有初始化事件，没有真实 user prompt，无法确定语言/任务边界。
    await saveAssistantMessage(store, {
      sessionID: String(childId),
      id: String(createMessageId()),
      created: 151,
    });

    await assert.rejects(
      store.resolveSubagentForkCheckpointGraph({
        parentSessionId: String(parent.id),
        boundaryMessageId: String(boundaryId),
      }),
      /Cannot prove immutable subagent snapshot/,
    );
  });
});

test("已有完整检查点仍按原样解析，不受前缀规则影响", async () => {
  await withStore(async (store) => {
    const parent = await createParent(store);
    const promptId = createMessageId();
    await saveUserMessage(store, {
      sessionID: String(parent.id),
      id: String(promptId),
      created: 100,
      text: "start",
      anchor: { origin: "realUser", sourceCommandId: "parent-input" },
    });
    const childId = createSessionId();
    await store.createSubagentChildSession(
      childInput({ id: childId, parentID: parent.id, time: { created: 150, updated: 150 } }),
      binding("agent_existing", String(childId)),
    );
    const childPromptId = createMessageId();
    await saveUserMessage(store, {
      sessionID: String(childId),
      id: String(childPromptId),
      created: 152,
      text: "delegated task",
      anchor: { origin: "realUser", sourceCommandId: "spawn" },
    });
    const history = await store.messages({ sessionID: childId });
    await store.saveSubagentForkCheckpoint({
      checkpointId: "existing-checkpoint",
      parentSessionId: String(parent.id),
      agentId: "agent_existing",
      childSessionId: String(childId),
      parentToolCallId: "agent_existing",
      boundaryMessageId: String(promptId),
      history,
      entries: [],
      profile: { name: "demo" },
      agentType: "general-purpose",
    });
    const graph = await store.resolveSubagentForkCheckpointGraph({
      parentSessionId: String(parent.id),
      boundaryMessageId: String(promptId),
    });
    assert.equal(graph.children[0]?.checkpoint.checkpointId, "existing-checkpoint");
    assert.equal(graph.children[0]?.history.length, 1);
  });
});
