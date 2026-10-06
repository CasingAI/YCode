// 覆盖模式的文件回滚回归测试（specs/message-history-edit.md 规则 26/29）。
//
// 规则 26：conflictMode=overwrite 只允许 external_modified 类冲突绕过阻塞；
//   unsupported/checkpoint_unreadable 等数据缺失类必须保持阻塞（覆盖无意义）。
// 规则 29：overwrite 在写盘前把「当前磁盘状态」持久化为 workspace checkpoint
//   （锚在编辑目标轮 user message 上）；append-only branch cut 不删消息，
//   后续再对同一锚点 rewind 时快照仍在恢复范围内——覆盖可逆。
import assert from "node:assert/strict";
import test from "node:test";
import { RewindScope, SessionEventType } from "@zcode/contracts";
import type { SessionEvent } from "@zcode/contracts";
import {
  WORKSPACE_CHECKPOINT_CONTENT_TYPE,
  stringifyWorkspaceCheckpointArtifact,
} from "../src/runtime/helpers/index.js";
import {
  applyWorkspaceFileRewind,
  previewWorkspaceFileRewind,
} from "../src/runtime/methods/file-rewind.js";

const WS_ROOT = "/ws";

type Harness = Awaited<ReturnType<typeof makeRuntime>>;

function makeRuntime() {
  const files = new Map<string, string>([[`${WS_ROOT}/a.txt`, "external"]]);
  const artifacts = new Map<string, string>();
  const events: SessionEvent[] = [];
  let seq = 0;

  const checkpointPayload = {
    checkpointId: "checkpoint_cp1",
    messageId: "msg-1",
    targetMessageId: "msg-1",
    scope: RewindScope.Workspace,
    snapshotRef: "artifact://cp1",
    diffRef: "artifact://cp1",
    fileCount: 1,
  };
  events.push({
    id: "evt-cp1",
    type: SessionEventType.CheckpointCreated,
    payload: checkpointPayload,
  } as unknown as SessionEvent);
  // CP1：Write 工具把 a.txt 从 "one" 改成 "two"（与磁盘 "external" 不一致 → external_modified）。
  artifacts.set(
    "artifact://cp1",
    stringifyWorkspaceCheckpointArtifact(
      { content: "two", filePath: "a.txt", originalFile: "one", structuredPatch: [] },
      {
        toolCallId: "call-1",
        toolName: "Write",
      } as Parameters<typeof stringifyWorkspaceCheckpointArtifact>[1],
    ),
  );

  const appended: SessionEvent[] = [];
  const runtime = {
    sessionId: "sess-rewind-overwrite",
    workspaceRoot: WS_ROOT,
    rootTraceContext: { traceId: "trace-rewind-overwrite", turnId: "turn-anchor" },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    eventStore: {
      getEvents: async () => events,
    },
    artifactStore: {
      readToolResultArtifact: async ({ uri }: { uri: string }) => {
        const content = artifacts.get(uri);
        if (content === undefined) throw new Error(`artifact not found: ${uri}`);
        return { content };
      },
      writeToolResultArtifact: async (input: {
        content: string;
        contentType: string;
      }) => {
        assert.equal(input.contentType, WORKSPACE_CHECKPOINT_CONTENT_TYPE);
        seq += 1;
        const uri = `artifact://snapshot-${seq}`;
        artifacts.set(uri, input.content);
        return { uri };
      },
    },
    fileSystemPort: {
      readTextFile: async ({ path }: { path: string }) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`missing: ${path}`);
        return { content };
      },
      writeTextFile: async ({ path, content }: { path: string; content: string }) => {
        files.set(path, content);
      },
      removeFile: async ({ path }: { path: string }) => {
        files.delete(path);
      },
    },
    createEvent: (type: SessionEventType, payload: unknown, trace: { turnId?: string }) => {
      seq += 1;
      return {
        id: `evt-${seq}`,
        type,
        payload,
        sessionId: "sess-rewind-overwrite",
        turnId: trace?.turnId,
      };
    },
    appendEvent: async (event: { type: SessionEventType; payload: unknown }) => {
      appended.push(event as unknown as SessionEvent);
      events.push(event as unknown as SessionEvent);
    },
  };

  return {
    runtime,
    files,
    artifacts,
    events,
    appended,
    checkpointPayload,
  };
}

const applyOverwrite = (
  harness: Harness,
  options: Parameters<typeof applyWorkspaceFileRewind>[1],
) =>
  applyWorkspaceFileRewind.call(
    harness.runtime as never,
    options,
  ) as unknown as ReturnType<typeof applyWorkspaceFileRewind>;

test("block 模式：external_modified 阻塞且不写盘", async () => {
  const harness = makeRuntime();
  const preview = await previewWorkspaceFileRewind.call(harness.runtime as never, {
    targetMessageIds: ["msg-1"],
  });
  assert.equal(preview.canApply, false);
  assert.equal(preview.unsafeFiles.length, 1);
  assert.equal(preview.unsafeFiles[0]?.reason, "external_modified");
  assert.equal(harness.files.get(`${WS_ROOT}/a.txt`), "external");
});

test("overwrite 模式：external_modified 放行，覆盖前快照持久化且文件恢复到 checkpoint 值", async () => {
  const harness = makeRuntime();
  const result = await applyOverwrite(harness, {
    conflictMode: "overwrite",
    anchorMessageId: "msg-0",
    targetMessageIds: ["msg-1"],
  });
  assert.equal(result.applied, true);
  assert.equal(harness.files.get(`${WS_ROOT}/a.txt`), "one", "恢复值来自 checkpoint 链");

  // 覆盖前快照：内容是写盘前的磁盘状态 "external"，锚在编辑目标轮 user message。
  const snapshotEvent = harness.appended.find(
    (event) => event.type === SessionEventType.CheckpointCreated,
  );
  assert.ok(snapshotEvent, "覆盖前必须先持久化快照 checkpoint");
  const payload = snapshotEvent.payload as { messageId?: string; snapshotRef?: string };
  assert.equal(payload.messageId, "msg-0");
  const snapshotArtifact = JSON.parse(
    harness.artifacts.get(payload.snapshotRef ?? "") ?? "{}",
  ) as { files: Array<{ beforeContent: string | null }> };
  assert.equal(snapshotArtifact.files[0]?.beforeContent, "external");

  assert.ok(
    harness.appended.some((event) => event.type === SessionEventType.RewindTriggered),
    "覆盖 apply 完成后必须发布 RewindTriggered",
  );
});

test("overwrite 模式：unsupported_checkpoint 仍阻塞（数据不在，覆盖无意义）", async () => {
  const harness = makeRuntime();
  // CP2：文件新建且无 afterContent/patch → unsupported_checkpoint。
  harness.artifacts.set(
    "artifact://cp2",
    stringifyWorkspaceCheckpointArtifact(
      { filePath: "b.txt", originalFile: null, structuredPatch: [] },
      {
        toolCallId: "call-2",
        toolName: "Write",
      } as Parameters<typeof stringifyWorkspaceCheckpointArtifact>[1],
    ),
  );
  harness.events.push({
    id: "evt-cp2",
    type: SessionEventType.CheckpointCreated,
    payload: { ...harness.checkpointPayload, checkpointId: "checkpoint_cp2", snapshotRef: "artifact://cp2", diffRef: "artifact://cp2" },
  } as unknown as SessionEvent);
  harness.files.set(`${WS_ROOT}/b.txt`, "later");

  const result = await applyOverwrite(harness, {
    conflictMode: "overwrite",
    anchorMessageId: "msg-0",
    targetMessageIds: ["msg-1"],
  });
  assert.equal(result.applied, false);
  assert.ok(
    result.preview.unsafeFiles.some((file) => file.reason === "unsupported_checkpoint"),
    "unsupported 类冲突不得被 overwrite 放行",
  );
  assert.equal(harness.files.get(`${WS_ROOT}/b.txt`), "later", "阻塞时不得写盘");
});

test("覆盖可逆：快照 checkpoint 可再次 rewind，找回被覆盖前的内容", async () => {
  const harness = makeRuntime();
  const first = await applyOverwrite(harness, {
    conflictMode: "overwrite",
    anchorMessageId: "msg-0",
    targetMessageIds: ["msg-1"],
  });
  assert.equal(first.applied, true);

  // 对覆盖前快照所在锚点（msg-0）再次 rewind：快照的恢复值是覆盖前的磁盘内容。
  const second = await applyOverwrite(harness, {
    conflictMode: "overwrite",
    anchorMessageId: "msg-0",
    targetMessageIds: ["msg-0"],
  });
  assert.equal(second.applied, true);
  assert.equal(
    harness.files.get(`${WS_ROOT}/a.txt`),
    "external",
    "再次 rewind 必须找回覆盖前的磁盘状态（快照可逆）",
  );
});
