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
    anchor?: Record<string, unknown>;
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
    ...(input.anchor ? { anchor: input.anchor } : {}),
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

test("启动即失败、没有任何转写的 child 不阻断 Fork，也不进入复制图", async () => {
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

    // 正常派发：有初始化事件与 realUser prompt，可回填检查点。
    const childId = createSessionId();
    await store.createSubagentChildSession(
      childInput({ id: childId, parentID: parent.id, time: { created: 150, updated: 150 } }),
      binding("agent_backfill", String(childId)),
    );
    await saveAssistantMessage(store, {
      sessionID: String(childId),
      id: String(createMessageId()),
      created: 151,
    });
    await saveUserMessage(store, {
      sessionID: String(childId),
      id: String(createMessageId()),
      created: 152,
      text: "delegated task",
      anchor: { origin: "realUser", sourceCommandId: "spawn" },
    });

    // 启动即失败的派发：模型准入阶段被拒，只留下会话行与身份，没有任何转写。
    const failedChildId = createSessionId();
    await store.createSubagentChildSession(
      childInput({
        id: failedChildId,
        parentID: parent.id,
        time: { created: 160, updated: 160 },
      }),
      binding("agent_startup_failed", String(failedChildId)),
    );

    const graph = await store.resolveSubagentForkCheckpointGraph({
      parentSessionId: String(parent.id),
      boundaryMessageId: String(boundaryId),
    });
    // 无转写的 child 没有可继承历史：不进入复制图，也不被复制成空 child。
    assert.deepEqual(
      graph.children.map((node) => node.checkpoint.agentId),
      ["agent_backfill"],
    );
    assert.equal(
      graph.children.some((node) => node.checkpoint.childSessionId === String(failedChildId)),
      false,
    );
    // 重复解析仍然只复制有转写的 child：被排除的 child 不会补出检查点行。
    const second = await store.resolveSubagentForkCheckpointGraph({
      parentSessionId: String(parent.id),
      boundaryMessageId: String(boundaryId),
    });
    assert.deepEqual(
      second.children.map((node) => node.checkpoint.agentId),
      ["agent_backfill"],
    );
  });
});

test("锚点落在可继承范围之外的 child 不阻断 Fork，也不写检查点", async () => {
  await withStore(async (store) => {
    const parent = await createParent(store);
    // 第一轮：真实用户输入 + 助手回答。
    const firstPromptId = createMessageId();
    await saveUserMessage(store, {
      sessionID: String(parent.id),
      id: String(firstPromptId),
      created: 100,
      text: "first",
      anchor: { origin: "realUser", sourceCommandId: "parent-input-1" },
    });
    await saveAssistantMessage(store, {
      sessionID: String(parent.id),
      id: String(createMessageId()),
      created: 200,
      completed: 250,
    });
    // 第二轮：Fork 边界所在轮次，orderedMessageIds 只覆盖这一轮。
    const secondPromptId = createMessageId();
    await saveUserMessage(store, {
      sessionID: String(parent.id),
      id: String(secondPromptId),
      created: 300,
      text: "second",
      anchor: { origin: "realUser", sourceCommandId: "parent-input-2" },
    });
    const boundaryId = createMessageId();
    await saveAssistantMessage(store, {
      sessionID: String(parent.id),
      id: String(boundaryId),
      created: 400,
      completed: 450,
      anchor: {
        orderedMessageIds: [String(secondPromptId), String(boundaryId)],
        boundaryMessageId: String(boundaryId),
      },
    });

    // 第一轮派发的 child：有转写，但锚点不在本次 Fork 的可继承范围内。
    const earlierChildId = createSessionId();
    await store.createSubagentChildSession(
      childInput({ id: earlierChildId, parentID: parent.id, time: { created: 160, updated: 160 } }),
      binding("agent_earlier_turn", String(earlierChildId)),
    );
    await saveAssistantMessage(store, {
      sessionID: String(earlierChildId),
      id: String(createMessageId()),
      created: 161,
    });
    await saveUserMessage(store, {
      sessionID: String(earlierChildId),
      id: String(createMessageId()),
      created: 162,
      text: "earlier delegated task",
      anchor: { origin: "realUser", sourceCommandId: "spawn" },
    });

    // 边界轮次派发的 child：锚点在可继承范围内，应被回填并进入复制图。
    const inScopeChildId = createSessionId();
    await store.createSubagentChildSession(
      childInput({ id: inScopeChildId, parentID: parent.id, time: { created: 360, updated: 360 } }),
      binding("agent_in_scope", String(inScopeChildId)),
    );
    await saveAssistantMessage(store, {
      sessionID: String(inScopeChildId),
      id: String(createMessageId()),
      created: 361,
    });
    await saveUserMessage(store, {
      sessionID: String(inScopeChildId),
      id: String(createMessageId()),
      created: 362,
      text: "in scope delegated task",
      anchor: { origin: "realUser", sourceCommandId: "spawn" },
    });

    const graph = await store.resolveSubagentForkCheckpointGraph({
      parentSessionId: String(parent.id),
      boundaryMessageId: String(boundaryId),
    });
    assert.deepEqual(
      graph.children.map((node) => node.checkpoint.agentId),
      ["agent_in_scope"],
    );
    assert.equal(
      graph.children[0]?.checkpoint.boundaryMessageId,
      String(secondPromptId),
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
