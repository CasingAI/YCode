import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionId,
  createProjectId,
  createMessageId,
  createPartId,
  type CreateSessionInput,
  type MessageWithParts,
  type SubagentExecutionClaim,
  type SubagentForkCheckpoint,
  type SubagentIdentityBinding,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";

async function withStore(
  run: (store: ReturnType<typeof createSqliteSessionStore>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-subagent-identity-"));
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

function binding(overrides: Partial<SubagentIdentityBinding> = {}): SubagentIdentityBinding {
  return {
    agentId: "agent_11111111-1111-1111-1111-111111111111",
    childSessionId: "sess_subagent_agent_11111111-1111-1111-1111-111111111111",
    agentType: "general-purpose",
    profile: { name: "demo", description: "d", systemPrompt: "p", source: "built-in" },
    workspaceRoot: "/workspace/demo",
    contextResetGeneration: 0,
    ...overrides,
  };
}

test("child session 与身份绑定在同一事务落库，可按 agentId 解析回来", async () => {
  await withStore(async (store) => {
    const input = childInput({ id: "sess_subagent_agent_11111111-1111-1111-1111-111111111111" });
    const identity = binding();
    const child = await store.createSubagentChildSession(input, identity);
    assert.equal(String(child.id), identity.childSessionId);

    const resolved = await store.resolveSubagentIdentity(identity.agentId);
    assert.ok(resolved);
    assert.equal(resolved.binding.childSessionId, identity.childSessionId);
    assert.equal(resolved.binding.agentType, "general-purpose");
    assert.equal(resolved.binding.workspaceRoot, "/workspace/demo");
    assert.equal(resolved.child.taskType, "subagent_child");
    // 身份层不存任务状态。
    assert.equal((resolved.binding as Record<string, unknown>).status, undefined);
  });
});

test("taskType 不是 subagent_child 时拒绝原子创建", async () => {
  await withStore(async (store) => {
    const input = childInput({
      id: "sess_subagent_agent_22222222-2222-2222-2222-222222222222",
      taskType: "interactive",
    });
    await assert.rejects(
      store.createSubagentChildSession(input, binding({ agentId: "agent_2222" })),
      /subagent_child/,
    );
  });
});

test("绑定 id 与待建 session 不一致时整体拒绝", async () => {
  await withStore(async (store) => {
    const input = childInput({ id: "sess_subagent_agent_33333333-3333-3333-3333-333333333333" });
    await assert.rejects(
      store.createSubagentChildSession(
        input,
        binding({
          agentId: "agent_3333",
          childSessionId: "sess_subagent_agent_other",
        }),
      ),
      /does not match/,
    );
  });
});

test("同 agentId 重复写同一映射幂等，指向不同 child 视为冲突", async () => {
  await withStore(async (store) => {
    const id = "sess_subagent_agent_44444444-4444-4444-4444-444444444444";
    const identity = binding({ agentId: "agent_4444", childSessionId: id });
    await store.createSubagentChildSession(childInput({ id }), identity);
    // 幂等：同一映射重复写不报错。
    await store.createSubagentChildSession(childInput({ id }), identity);

    const other = "sess_subagent_agent_55555555-5555-5555-5555-555555555555";
    // 指向不同 child 是显式冲突：覆盖会让旧 transcript 变成孤儿，
    // 之后 SendMessage 会在错误的 child 上继续跑。
    await assert.rejects(
      store.createSubagentChildSession(childInput({ id: other }), {
        ...identity,
        childSessionId: other,
      }),
      /conflict/,
    );
    // 原绑定没有被改写。
    const resolved = await store.resolveSubagentIdentity("agent_4444");
    assert.equal(resolved?.binding.childSessionId, id);
  });
});

test("历史 child session 走 lazy backfill 被找回，且不改写 transcript", async () => {
  await withStore(async (store) => {
    const legacyId = "sess_subagent_agent_66666666-6666-6666-6666-666666666666";
    // 旧版本创建的 child session：没有身份行，但命名符合约定。
    await store.createSession(childInput({ id: legacyId }));

    const resolved = await store.resolveSubagentIdentity("agent_66666666-6666-6666-6666-666666666666");
    assert.ok(resolved);
    assert.equal(resolved.binding.childSessionId, legacyId);
    // 旧记录没有 profile 快照，不伪造。
    assert.deepEqual(resolved.binding.profile, {});
    assert.equal(resolved.child.taskType, "subagent_child");
  });
});

test("命名不符合约定或 taskType 不符的历史记录不会被回填", async () => {
  await withStore(async (store) => {
    assert.equal(await store.resolveSubagentIdentity("agent_never_existed"), null);
    await store.createSession(
      childInput({ id: "sess_subagent_agent_77777777-7777-7777-7777-777777777777" }),
    );
    // child 存在但不是 subagent_child 时不得当成可执行 Agent。
    await store.createSession(
      childInput({
        id: "sess_subagent_agent_88888888-8888-8888-8888-888888888888",
        taskType: "interactive",
      }),
    );
    assert.equal(
      await store.resolveSubagentIdentity("agent_88888888-8888-8888-8888-888888888888"),
      null,
    );
  });
});

test("不可变 child 快照可重复读取，后续原 transcript 写入不会污染检查点，claim 使用单调 fencing epoch", async () => {
  await withStore(async (store) => {
    const parent = await store.createSession({
      id: createSessionId(),
      projectID: createProjectId(),
      slug: "parent",
      directory: "/workspace/demo",
      title: "parent",
      version: "0.0.0-test",
    });
    const agentId = "agent_fork_checkpoint";
    const childId = createSessionId();
    await store.createSubagentChildSession(childInput({ id: childId, parentID: parent.id }), binding({
      agentId,
      childSessionId: String(childId),
    }));
    const parentMessageId = createMessageId();
    const childMessageId = createMessageId();
    await store.saveMessage({
      id: parentMessageId,
      sessionID: parent.id,
      role: "user",
      time: { created: 10 },
      text: "Fork boundary",
      anchor: { origin: "realUser", sourceCommandId: "parent-input" },
    } as never);
    await store.saveMessage({
      id: childMessageId,
      sessionID: childId,
      role: "user",
      time: { created: 11 },
      text: "fixed input",
    } as never);
    const childPartId = createPartId();
    await store.savePart({
      id: childPartId,
      sessionID: childId,
      messageID: childMessageId,
      type: "text",
      text: "fixed input",
    });
    const snapshot: MessageWithParts[] = [{
      info: {
        id: childMessageId,
        sessionID: childId,
        role: "user",
        time: { created: 11 },
        text: "fixed input",
      } as never,
      parts: [{
        id: childPartId,
        sessionID: childId,
        messageID: childMessageId,
        type: "text",
        text: "fixed input",
      }],
    }];
    const checkpoint: SubagentForkCheckpoint = {
      checkpointId: "checkpoint-one",
      parentSessionId: String(parent.id),
      agentId,
      childSessionId: String(childId),
      parentToolCallId: "tool-call-one",
      boundaryMessageId: String(parentMessageId),
      history: snapshot,
      entries: [],
      profile: { name: "agent", description: "agent", systemPrompt: "system", source: "built-in" },
      agentType: "general-purpose",
    };
    assert.equal((await store.saveSubagentForkCheckpoint(checkpoint)).created, true);
    assert.equal((await store.saveSubagentForkCheckpoint(checkpoint)).created, false);
    const changed = structuredClone(checkpoint);
    changed.history[0]!.info.text = "changed after checkpoint";
    await assert.rejects(store.saveSubagentForkCheckpoint(changed), /immutable/);
    const graph = await store.resolveSubagentForkCheckpointGraph({
      parentSessionId: String(parent.id),
      boundaryMessageId: String(parentMessageId),
    });
    assert.equal(graph.children[0]?.history[0]?.info.role, "user");
    assert.deepEqual(graph.children[0]?.history[0]?.parts.map((part) => part.type), ["text"]);

    const first = await store.acquireSubagentExecutionClaim({
      childSessionId: String(childId),
      ownerRuntimeId: "runtime-one",
      now: 100,
      leaseMs: 10,
    });
    assert.equal(first.acquired, true);
    assert.equal((await store.acquireSubagentExecutionClaim({
      childSessionId: String(childId),
      ownerRuntimeId: "runtime-two",
      now: 105,
      leaseMs: 10,
    })).acquired, false);
    const takeover = await store.acquireSubagentExecutionClaim({
      childSessionId: String(childId),
      ownerRuntimeId: "runtime-two",
      now: 111,
      leaseMs: 10,
    });
    assert.equal(takeover.acquired, true);
    assert.ok((takeover.claim?.fencingEpoch ?? 0) > (first.claim?.fencingEpoch ?? 0));
    assert.equal(await store.releaseSubagentExecutionClaim({
      childSessionId: String(childId),
      ownerRuntimeId: "runtime-one",
      fencingEpoch: first.claim!.fencingEpoch,
    }), false);
    assert.equal(await store.releaseSubagentExecutionClaim({
      childSessionId: String(childId),
      ownerRuntimeId: "runtime-two",
      fencingEpoch: takeover.claim!.fencingEpoch,
    }), true);
    const reacquired = await store.acquireSubagentExecutionClaim({
      childSessionId: String(childId),
      ownerRuntimeId: "runtime-two",
      now: 112,
      leaseMs: 10,
    });
    assert.ok(reacquired.claim!.fencingEpoch > takeover.claim!.fencingEpoch);
    assert.equal(await store.releaseSubagentExecutionClaim({
      childSessionId: String(childId),
      ownerRuntimeId: "runtime-two",
      fencingEpoch: takeover.claim!.fencingEpoch,
    }), false);
    // Fork graph 由 parent 历史锚点决定；后续新建的 child checkpoint 不会加入旧边界。
    const laterChildId = createSessionId();
    const laterAgentId = "agent_after_boundary";
    await store.createSubagentChildSession(
      childInput({ id: laterChildId, parentID: parent.id }),
      binding({ agentId: laterAgentId, childSessionId: String(laterChildId) }),
    );
    const laterMessageId = createMessageId();
    await store.saveMessage({
      id: laterMessageId,
      sessionID: parent.id,
      role: "user",
      time: { created: 12 },
      text: "Later boundary",
      anchor: { origin: "realUser", sourceCommandId: "later-input" },
    } as never);
    await store.saveMessage({
      id: createMessageId(),
      sessionID: laterChildId,
      role: "user",
      time: { created: 13 },
      text: "later child input",
    } as never);
    const laterHistory = await store.messages({ sessionID: laterChildId });
    await store.saveSubagentForkCheckpoint({
      ...checkpoint,
      checkpointId: "checkpoint-later",
      agentId: laterAgentId,
      childSessionId: String(laterChildId),
      boundaryMessageId: String(laterMessageId),
      history: laterHistory,
    });
    const historicalGraph = await store.resolveSubagentForkCheckpointGraph({
      parentSessionId: String(parent.id),
      boundaryMessageId: String(parentMessageId),
    });
    assert.deepEqual(historicalGraph.children.map((node) => node.checkpoint.agentId), [agentId]);

    // 同一 child 的后续检查点只能替换当前边界内的旧版本，不能同时复制成两个 Agent。
    await store.saveSubagentForkCheckpoint({
      ...checkpoint,
      checkpointId: "checkpoint-one-later",
      boundaryMessageId: String(laterMessageId),
    });
    const latestGraph = await store.resolveSubagentForkCheckpointGraph({
      parentSessionId: String(parent.id),
      boundaryMessageId: String(laterMessageId),
    });
    assert.equal(latestGraph.children.filter((node) => node.checkpoint.agentId === agentId).length, 1);
    assert.equal(latestGraph.children.find((node) => node.checkpoint.agentId === agentId)?.checkpoint.checkpointId, "checkpoint-one-later");
  });
});

test("身份行悬空（child 被删）时解析返回 null 而不是可执行 Agent", async () => {
  await withStore(async (store) => {
    const id = "sess_subagent_agent_99999999-9999-9999-9999-999999999999";
    const identity = binding({ agentId: "agent_9999", childSessionId: id });
    await store.createSubagentChildSession(childInput({ id }), identity);
    assert.ok(await store.resolveSubagentIdentity("agent_9999"));
  });
});
