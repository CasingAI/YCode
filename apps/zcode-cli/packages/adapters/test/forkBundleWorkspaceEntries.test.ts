// commitForkBundle 条目原子性与父条目不改绑的回归测试
// （specs/message-history-edit.md 规则 35 / 验收 16 的存储层部分）。
//
// session_entry.id 是全库主键、写入是 on-conflict 更新：fork 继承的 checkpoint /
// file-rewind 条目必须以子会话新身份落库，父条目不得被改绑。事务侧此前只有
// forkCommitFaultAt 故障注入开关、没有对应测试，这里补上「全有或全无」断言。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RewindScope,
  RewindStrategy,
  SESSION_ENTRY_WORKSPACE_CHECKPOINT,
  SESSION_ENTRY_WORKSPACE_FILE_REWIND,
  createMessageId,
  createProjectId,
  type CreateSessionInput,
  type ForkCommitBundle,
  type MessageWithParts,
  type SessionEntryInfo,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";
import type { ForkCommitFaultStage } from "../src/storage/session-store/options.js";

const PARENT_ID = "sess_forkatomic_parent";
const CHILD_ID = "sess_forkatomic_child";
const NOW = 1_700_000_000_000;

async function withStore(
  run: (store: ReturnType<typeof createSqliteSessionStore>) => Promise<void>,
  options: { forkCommitFaultAt?: ForkCommitFaultStage } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-fork-bundle-atomic-"));
  const store = createSqliteSessionStore({
    dbPath: join(dir, "session.db"),
    ...options,
  });
  try {
    await run(store);
  } finally {
    store.close?.();
    await rm(dir, { recursive: true, force: true });
  }
}

function sessionInput(id: string, overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    id,
    projectID: createProjectId(),
    taskType: "interactive",
    slug: "fork-atomic",
    directory: "/workspace/demo",
    path: "/workspace/demo",
    title: id,
    version: "0.0.0-test",
    ...overrides,
  };
}

function parentCheckpointEntry(): SessionEntryInfo {
  return {
    id: "workspace-checkpoint:evt-parent-1",
    sessionID: PARENT_ID,
    type: SESSION_ENTRY_WORKSPACE_CHECKPOINT,
    time: { created: NOW, updated: NOW },
    data: {
      eventId: "evt-parent-1",
      payload: {
        checkpointId: "checkpoint_cp1",
        messageId: "msg-parent-1",
        targetMessageId: "msg-parent-1",
        scope: RewindScope.Workspace,
        snapshotRef: "zcode-artifact://sess_forkatomic_parent/artifact-1",
      },
      sequenceNumber: 7,
      traceId: "trace-parent",
      turnId: "turn-parent-1",
    },
  };
}

function parentFileRewindEntry(): SessionEntryInfo {
  return {
    id: "workspace-file-rewind:rewind_parent_1",
    sessionID: PARENT_ID,
    type: SESSION_ENTRY_WORKSPACE_FILE_REWIND,
    time: { created: NOW + 1, updated: NOW + 1 },
    data: {
      eventId: "evt-parent-2",
      payload: {
        rewindId: "rewind_parent_1",
        scope: RewindScope.Workspace,
        strategy: RewindStrategy.ActiveChain,
        targetMessageId: "msg-parent-1",
        reason: "file_summary_rewind",
      },
      sequenceNumber: 9,
      traceId: "trace-parent",
    },
  };
}

// 与 core remap 输出同构：子会话身份、重生成后的条目/事件/撤销身份。
function childInheritedEntries(): SessionEntryInfo[] {
  return [
    {
      id: "workspace-checkpoint:evt-child-1",
      sessionID: CHILD_ID,
      type: SESSION_ENTRY_WORKSPACE_CHECKPOINT,
      time: { created: NOW, updated: NOW },
      data: {
        eventId: "evt-child-1",
        payload: {
          checkpointId: "checkpoint_cp1",
          messageId: "child-msg-1",
          targetMessageId: "child-msg-1",
          scope: RewindScope.Workspace,
          snapshotRef: "zcode-artifact://sess_forkatomic_parent/artifact-1",
        },
        sequenceNumber: 7,
        traceId: "trace-parent",
        turnId: "turn-child-1",
      },
    },
    {
      id: "workspace-file-rewind:rewind_child_1",
      sessionID: CHILD_ID,
      type: SESSION_ENTRY_WORKSPACE_FILE_REWIND,
      time: { created: NOW + 1, updated: NOW + 1 },
      data: {
        eventId: "evt-child-2",
        payload: {
          rewindId: "rewind_child_1",
          scope: RewindScope.Workspace,
          strategy: RewindStrategy.ActiveChain,
          targetMessageId: "child-msg-1",
          reason: "file_summary_rewind",
        },
        sequenceNumber: 9,
        traceId: "trace-parent",
      },
    },
  ];
}

function forkBundle(): ForkCommitBundle {
  return {
    child: sessionInput(CHILD_ID, { parentID: PARENT_ID, title: "child" }),
    messages: [
      {
        info: {
          id: createMessageId(),
          sessionID: CHILD_ID,
          role: "user",
          time: { created: NOW },
          agent: "build",
        },
        parts: [],
      } as unknown as MessageWithParts,
    ],
    entries: childInheritedEntries(),
    commandFact: {
      parentSessionId: PARENT_ID,
      sourceCommandId: "cmd-fork-atomic-1",
      ack: {
        commandId: "cmd-fork-atomic-1",
        status: "accepted",
        revisionAtDecision: 0,
        result: { type: "forkAssistant", sessionId: CHILD_ID },
      },
      metadata: {},
    },
  };
}

async function seedParent(store: ReturnType<typeof createSqliteSessionStore>): Promise<void> {
  await store.createSession(sessionInput(PARENT_ID));
  await store.saveSessionEntry(parentCheckpointEntry());
  await store.saveSessionEntry(parentFileRewindEntry());
}

test("checkpoint 与已撤销条目随包落库到子会话，父条目不被改绑", async () => {
  await withStore(async (store) => {
    await seedParent(store);
    await store.commitForkBundle(forkBundle());

    const childCheckpoints = await store.sessionEntries({
      sessionID: CHILD_ID,
      type: SESSION_ENTRY_WORKSPACE_CHECKPOINT,
    });
    assert.equal(childCheckpoints.length, 1, "子会话应拿到重映射后的 checkpoint 条目");
    assert.equal(childCheckpoints[0]?.sessionID, CHILD_ID);

    const childRewinds = await store.sessionEntries({
      sessionID: CHILD_ID,
      type: SESSION_ENTRY_WORKSPACE_FILE_REWIND,
    });
    assert.equal(childRewinds.length, 1, "子会话应拿到重映射后的已撤销条目");

    // 父条目原样保留：id 是全库主键，on-conflict 更新会把父条目改绑到子会话。
    const parentCheckpoints = await store.sessionEntries({
      sessionID: PARENT_ID,
      type: SESSION_ENTRY_WORKSPACE_CHECKPOINT,
    });
    assert.equal(parentCheckpoints.length, 1);
    assert.equal(parentCheckpoints[0]?.id, "workspace-checkpoint:evt-parent-1");
    assert.equal(parentCheckpoints[0]?.sessionID, PARENT_ID);

    const parentRewinds = await store.sessionEntries({
      sessionID: PARENT_ID,
      type: SESSION_ENTRY_WORKSPACE_FILE_REWIND,
    });
    assert.equal(parentRewinds.length, 1);
    assert.equal(parentRewinds[0]?.sessionID, PARENT_ID);
  });
});

test("afterEntries 注入失败：child / messages / 全部 entries 整包回滚", async () => {
  await withStore(
    async (store) => {
      await seedParent(store);
      await assert.rejects(
        store.commitForkBundle(forkBundle()),
        undefined,
        "故障档位必须让提交失败",
      );

      assert.equal(await store.getSession(CHILD_ID), null, "child session 必须随事务回滚");
      assert.deepEqual(
        await store.messages({ sessionID: CHILD_ID }),
        [],
        "child messages 必须随事务回滚",
      );
      assert.equal(
        (await store.sessionEntries({ sessionID: CHILD_ID, type: SESSION_ENTRY_WORKSPACE_CHECKPOINT }))
          .length,
        0,
      );
      assert.equal(
        (
          await store.sessionEntries({
            sessionID: CHILD_ID,
            type: SESSION_ENTRY_WORKSPACE_FILE_REWIND,
          })
        ).length,
        0,
      );
      // 父会话数据不受失败影响。
      assert.ok(await store.getSession(PARENT_ID));
      assert.equal(
        (await store.sessionEntries({ sessionID: PARENT_ID, type: SESSION_ENTRY_WORKSPACE_CHECKPOINT }))
          .length,
        1,
      );
    },
    { forkCommitFaultAt: "afterEntries" },
  );
});
