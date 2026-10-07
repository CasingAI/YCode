// regenerateTaskTitle / renameTask 的远端路由透传（与 sendPrompt 同形）。
//
// 回归目标：Web 远端 workspace 下「重新生成标题」命令丢失 remoteSessionId，
// 落到错误的本机进程被拒。锁定：显式参数优先、内存态兜底、无记录时退回原样。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import { setDataBaseDir } from "../src/paths.js";

type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];

interface CapturedCommand {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  type: string;
}

function createService(captured: CapturedCommand[]) {
  const disposable = () => ({ dispose() {} });
  return createZCodeTaskServiceAdapter({
    zcodeAgentService: {
      async sendConversationCommandV4(params: {
        workspacePath: string;
        workspaceIdentity?: string;
        remoteSessionId?: string;
        envelope: { type: string };
      }) {
        captured.push({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          remoteSessionId: params.remoteSessionId,
          type: params.envelope.type,
        });
        return { commandId: "test-command", status: "accepted", revisionAtDecision: 0 };
      },
      disposeAll() {},
    } as unknown as Options["zcodeAgentService"],
    taskIndexSyncer: {
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      // regenerate 不写本地索引、不广播；rename 的广播走同一 emitter。
      emitWorkspaceTaskListChanged() {},
      disposeAll() {},
    } as unknown as Options["taskIndexSyncer"],
  });
}

test("regenerateTaskTitle 携带 remoteSessionId 到远端 host", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-regenerate-remote-"));
  setDataBaseDir(dir);
  try {
    const captured: CapturedCommand[] = [];
    const service = createService(captured);
    await service.regenerateTaskTitle({
      taskId: "task-remote",
      workspacePath: "/remote/workspace",
      workspaceIdentity: "remote:ssh:test",
      remoteSessionId: "remote-session-1",
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.type, "regenerateSessionTitle");
    assert.equal(captured[0]?.remoteSessionId, "remote-session-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("regenerateTaskTitle 本地路径不带 remoteSessionId（语义不变）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-regenerate-local-"));
  setDataBaseDir(dir);
  try {
    const captured: CapturedCommand[] = [];
    const service = createService(captured);
    await service.regenerateTaskTitle({
      taskId: "task-local",
      workspacePath: "/local/workspace",
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.remoteSessionId, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renameTask 同样透传 remoteSessionId", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-rename-remote-"));
  setDataBaseDir(dir);
  try {
    const captured: CapturedCommand[] = [];
    const service = createService(captured);
    const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
    await repo.syncTaskMeta({
      meta: {
        taskId: "task-rename",
        traceId: "trace-rename",
        workspacePath: "/remote/workspace",
        workspaceIdentity: "remote:ssh:test",
        title: "旧标题",
        mode: "build" as const,
        provider: "glm" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
    await service.renameTask({
      taskId: "task-rename",
      workspacePath: "/remote/workspace",
      workspaceIdentity: "remote:ssh:test",
      remoteSessionId: "remote-session-1",
      title: "新标题",
    });
    const renameCall = captured.find((call) => call.type === "renameSession");
    assert.ok(renameCall, "应发出 renameSession 命令");
    assert.equal(renameCall?.remoteSessionId, "remote-session-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
