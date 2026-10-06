// fork 继承 workspace checkpoint / file-rewind 条目的重映射测试
// （specs/message-history-edit.md 规则 31-36）。
//
// buildInheritedWorkspaceEntries 是 fork 提交包 entries 的装配器：过滤（scope、
// 被复制历史）、身份重生成（条目 id / eventId / rewindId）、payload 消息身份映射、
// 条目外壳 turn 映射与降级策略都在这里，直接对着它断言。
import assert from "node:assert/strict";
import test from "node:test";
import { RewindScope, RewindStrategy } from "@zcode/contracts";
import type { SessionEntryInfo } from "@zcode/contracts";
import { buildInheritedWorkspaceEntries } from "../src/runtime/methods/workspace-checkpoint-fork-inheritance.js";

const PARENT = "sess-parent";
const CHILD = "sess-child";
const TRACE = { traceId: "trace-fork-inherit" };

function checkpointEntry(overrides: {
  id?: string;
  payload?: Record<string, unknown>;
  turnId?: string;
}): SessionEntryInfo {
  return {
    id: overrides.id ?? "workspace-checkpoint:evt-parent-1",
    sessionID: PARENT,
    type: "runtime/workspace_checkpoint",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
    data: {
      eventId: "evt-parent-1",
      payload:
        overrides.payload ?? {
          checkpointId: "checkpoint_cp1",
          messageId: "msg-user-1",
          targetMessageId: "msg-user-1",
          toolMessageId: "msg-tool-1",
          scope: RewindScope.Workspace,
          snapshotRef: "zcode-artifact://sess-parent/artifact-1",
          fileCount: 2,
        },
      sequenceNumber: 7,
      traceId: "trace-parent",
      ...(overrides.turnId ? { turnId: overrides.turnId } : {}),
    },
  } as unknown as SessionEntryInfo;
}

function fileRewindEntry(overrides: {
  payload?: Record<string, unknown>;
  turnId?: string;
}): SessionEntryInfo {
  return {
    id: `workspace-file-rewind:${overrides.payload?.rewindId ?? "rewind_parent_1"}`,
    sessionID: PARENT,
    type: "runtime/workspace_file_rewind",
    time: { created: 1_700_000_000_100, updated: 1_700_000_000_100 },
    data: {
      eventId: "evt-parent-2",
      payload:
        overrides.payload ?? {
          rewindId: "rewind_parent_1",
          scope: RewindScope.Workspace,
          strategy: RewindStrategy.ActiveChain,
          targetMessageId: "msg-user-1",
          targetCheckpointId: "checkpoint_cp1",
          restoredSnapshotRef: "zcode-artifact://sess-parent/artifact-1",
          reason: "file_summary_rewind",
        },
      sequenceNumber: 9,
      traceId: "trace-parent",
      ...(overrides.turnId ? { turnId: overrides.turnId } : {}),
    },
  } as unknown as SessionEntryInfo;
}

function harness(entries: SessionEntryInfo[]) {
  const warnings: Array<{ reason?: string; entryId?: string }> = [];
  const runtime = {
    sessionId: PARENT,
    sessionStore: {
      sessionEntries: async (query: { type: string }) =>
        entries.filter((entry) => entry.type === query.type),
    },
    logger: {
      warn: (...args: unknown[]) => {
        const context = args[1] as { reason?: string; entryId?: string } | undefined;
        warnings.push(context ?? {});
      },
    },
  };
  const identities = {
    messageIds: new Map([
      ["msg-user-1", "child-msg-user-1"],
      ["msg-tool-1", "child-msg-tool-1"],
    ]),
    turnIds: new Map([["turn-parent-1", "turn-child-1"]]),
  };
  const run = (kind: "fork" | "selection_side_chat" = "fork") =>
    buildInheritedWorkspaceEntries(runtime as never, {
      childSessionId: CHILD,
      identities,
      kind,
      traceContext: TRACE,
    });
  return { run, warnings, identities };
}

test("checkpoint 条目重映射：身份全换成子会话本地值，checkpointId/snapshotRef/序号沿用父值", async () => {
  const { run } = harness([checkpointEntry({ turnId: "turn-parent-1" })]);
  const [entry] = await run();
  assert.ok(entry, "命中被复制历史的 checkpoint 必须被继承");
  assert.equal(entry.sessionID, CHILD);
  assert.match(entry.id, /^workspace-checkpoint:[0-9a-f-]{36}$/);
  assert.notEqual(entry.id, "workspace-checkpoint:evt-parent-1", "条目 id 必须重生成（全库主键）");
  const data = entry.data as { eventId: string; payload: Record<string, unknown> };
  assert.notEqual(data.eventId, "evt-parent-1", "事件身份必须重生成");
  assert.equal(data.payload.messageId, "child-msg-user-1");
  assert.equal(data.payload.targetMessageId, "child-msg-user-1");
  assert.equal(data.payload.toolMessageId, "child-msg-tool-1");
  assert.equal(data.payload.checkpointId, "checkpoint_cp1", "恢复去重键保持父值");
  assert.equal(data.payload.snapshotRef, "zcode-artifact://sess-parent/artifact-1");
  assert.equal(
    (entry.data as { sequenceNumber: number }).sequenceNumber,
    7,
    "序号沿用父值，不重编号",
  );
  assert.equal((entry.data as { turnId?: string }).turnId, "turn-child-1");
  assert.deepEqual(entry.time, { created: 1_700_000_000_000, updated: 1_700_000_000_000 });
});

test("过滤：conversation scope 不继承；目标消息不在复制范围不继承", async () => {
  const { run, warnings } = harness([
    checkpointEntry({
      payload: {
        checkpointId: "cp-conversation",
        messageId: "msg-user-1",
        scope: RewindScope.Conversation,
        snapshotRef: "ref",
      },
    }),
    checkpointEntry({
      payload: {
        checkpointId: "cp-outside",
        messageId: "msg-outside",
        targetMessageId: "msg-outside",
        scope: RewindScope.Workspace,
        snapshotRef: "ref",
      },
    }),
  ]);
  const result = await run();
  assert.equal(result.length, 0, "conversation scope 与范围外条目都不得进入提交包");
  assert.equal(
    warnings.some((item) => item.reason === "unmapped_anchor_message_id"),
    true,
    "范围外条目丢弃要留 warn",
  );
});

test("降级：toolMessageId 与外壳 turnId 无映射时删字段保条目", async () => {
  const { run, warnings } = harness([
    checkpointEntry({
      payload: {
        checkpointId: "cp-1",
        messageId: "msg-user-1",
        targetMessageId: "msg-user-1",
        toolMessageId: "msg-tool-orphan",
        scope: RewindScope.Workspace,
        snapshotRef: "ref",
      },
      turnId: "turn-parent-orphan",
    }),
  ]);
  const [entry] = await run();
  assert.ok(entry, "主身份可映射时条目必须保留");
  const data = entry.data as { payload: Record<string, unknown>; turnId?: string };
  assert.equal("toolMessageId" in data.payload, false, "无映射的工具消息身份必须删除");
  assert.equal("turnId" in data, false, "无映射的外壳 turn 必须删除");
  assert.equal(
    warnings.filter((item) => item.reason === "unmapped_tool_message_id_removed").length,
    1,
  );
  assert.equal(
    warnings.filter((item) => item.reason === "unmapped_turn_id_field_removed").length,
    1,
  );
});

test("主身份（messageId）无映射：丢弃整条 + warn", async () => {
  const { run, warnings } = harness([
    checkpointEntry({
      payload: {
        checkpointId: "cp-orphan",
        messageId: "msg-orphan",
        scope: RewindScope.Workspace,
        snapshotRef: "ref",
      },
    }),
  ]);
  const result = await run();
  assert.equal(result.length, 0);
  assert.equal(
    warnings.some((item) => item.reason === "unmapped_anchor_message_id"),
    true,
  );
});

test("file-rewind 条目：rewindId 与条目 id 重生成、targetMessageId 重映射", async () => {
  const { run } = harness([fileRewindEntry({ turnId: "turn-parent-1" })]);
  const [entry] = await run();
  assert.ok(entry, "带可映射目标消息的已撤销条目必须继承");
  assert.equal(entry.sessionID, CHILD);
  assert.match(entry.id, /^workspace-file-rewind:rewind_[0-9a-f-]{36}$/);
  assert.notEqual(entry.id, "workspace-file-rewind:rewind_parent_1");
  const data = entry.data as {
    eventId: string;
    payload: Record<string, unknown>;
    turnId?: string;
  };
  assert.notEqual(data.eventId, "evt-parent-2");
  const payload = data.payload as { rewindId: string } & Record<string, unknown>;
  assert.notEqual(payload.rewindId, "rewind_parent_1", "撤销身份必须重生成（恢复去重键）");
  assert.equal(entry.id, `workspace-file-rewind:${payload.rewindId}`, "条目 id 与 rewindId 一致");
  assert.equal(payload.targetMessageId, "child-msg-user-1");
  assert.equal(payload.targetCheckpointId, "checkpoint_cp1", "checkpoint 引用保持父值");
  assert.equal(payload.restoredSnapshotRef, "zcode-artifact://sess-parent/artifact-1");
  assert.equal(data.turnId, "turn-child-1");
});

test("file-rewind 条目：缺 targetMessageId 一律丢弃（投影无法标已撤销）", async () => {
  const { run, warnings } = harness([
    fileRewindEntry({
      payload: {
        rewindId: "rewind_parent_2",
        scope: RewindScope.Workspace,
        strategy: RewindStrategy.ActiveChain,
        reason: "file_summary_rewind",
      },
    }),
  ]);
  const result = await run();
  assert.equal(result.length, 0, "缺目标消息身份的条目是死条目，不得带进子会话");
  assert.equal(
    warnings.some((item) => item.reason === "missing_target_message_id"),
    true,
  );
});

test("副屏：selection_side_chat 不继承任何条目", async () => {
  const { run } = harness([checkpointEntry({}), fileRewindEntry({})]);
  const result = await run("selection_side_chat");
  assert.deepEqual(result, []);
});

test("store 未实现条目端口：跳过继承，不让 fork 失败", async () => {
  const runtime = { sessionId: PARENT, sessionStore: {}, logger: { warn: () => {} } };
  const result = await buildInheritedWorkspaceEntries(runtime as never, {
    childSessionId: CHILD,
    identities: { messageIds: new Map(), turnIds: new Map() },
    kind: "fork",
    traceContext: TRACE,
  });
  assert.deepEqual(result, []);
});
