// fork 继承条目 → 子会话 resume 灌回 → 冷投影 fileChanges 的链路回归
// （specs/message-history-edit.md 规则 31 / 验收 16）。
//
// 子会话拿到的是重映射后的 workspace checkpoint 条目；restoreWorkspaceCheckpointEntries
// 在 resume 时把它灌回内存事件库，buildColdFileChangeSummaries 据此产出
// TurnFileChangeSummary，UI 的文件重置按钮与 preview 才可用。条目形状与
// core fork 继承（workspace-checkpoint-fork-inheritance.ts）的输出同构。
import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_ENTRY_WORKSPACE_CHECKPOINT,
  SessionEventType,
  type SessionEvent,
  type SessionEntryInfo,
} from "@zcode/contracts";
import { restoreWorkspaceCheckpointEntries } from "../../core/src/runtime/methods/workspace-checkpoint-persistence.js";
import { buildColdFileChangeSummaries } from "../src/zcode-protocol-v4/cold-file-change-summaries.js";

const CHILD = "sess_fork_inherit_child";
const NOW = 1_700_000_000_000;

function inheritedCheckpointEntry(): SessionEntryInfo {
  return {
    id: "workspace-checkpoint:evt-child-1",
    sessionID: CHILD,
    type: SESSION_ENTRY_WORKSPACE_CHECKPOINT,
    time: { created: NOW, updated: NOW },
    data: {
      eventId: "evt-child-1",
      payload: {
        checkpointId: "checkpoint_cp1",
        messageId: "child-msg-1",
        targetMessageId: "child-msg-1",
        toolMessageId: "child-msg-tool-1",
        scope: "workspace",
        snapshotRef: "zcode-artifact://sess_fork_parent/artifact-1",
        fileCount: 1,
      },
      sequenceNumber: 7,
      traceId: "trace-parent",
      turnId: "turn-child-1",
    },
  } as unknown as SessionEntryInfo;
}

test("子会话 resume 灌回继承条目后，冷投影能产出 fileChanges", async () => {
  const appended: SessionEvent[] = [];
  const runtime = {
    sessionId: CHILD,
    sessionStore: {
      sessionEntries: async (query: { type: string }) =>
        query.type === SESSION_ENTRY_WORKSPACE_CHECKPOINT ? [inheritedCheckpointEntry()] : [],
    },
    eventStore: {
      getEvents: async () => [] as SessionEvent[],
      append: async (event: SessionEvent) => {
        appended.push(event);
      },
    },
    logger: { warn: () => {} },
  };
  await restoreWorkspaceCheckpointEntries(runtime as never, { traceId: "trace-resume" });

  assert.equal(appended.length, 1, "继承条目必须被灌回子会话内存事件库");
  assert.equal(
    appended[0]?.type,
    SessionEventType.CheckpointCreated,
    "灌回的是 CheckpointCreated 事件",
  );

  // 父 artifact 按 URI 内嵌的父会话目录直读，内容对子会话透明。
  const artifact = {
    version: 1,
    kind: "workspace_file_before_change",
    createdAt: new Date(NOW).toISOString(),
    toolCallId: "call-1",
    toolName: "Write",
    files: [
      {
        path: "a.txt",
        existedBefore: true,
        beforeContent: "one",
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-one", "+two"] },
        ],
      },
    ],
  };
  const summaries = await buildColdFileChangeSummaries({
    events: appended,
    messageIds: ["child-msg-1"],
    readArtifact: async () => JSON.stringify(artifact),
  });
  const summary = summaries.get("child-msg-1");
  assert.ok(summary, "冷投影必须按重映射后的 targetMessageId 聚合出摘要");
  assert.equal(summary.files, 1);
  assert.equal(summary.additions, 1);
  assert.equal(summary.deletions, 1);
  assert.deepEqual(summary.items[0]?.path, "a.txt");
});
