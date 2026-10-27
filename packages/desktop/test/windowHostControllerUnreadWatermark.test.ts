import assert from "node:assert/strict";
import test from "node:test";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { createWindowHostControllerRuntime } from "../src/host/windowHostControllerService.js";

const WORKSPACE_PATH = "/example/workspace";
const TASK_ID = "task-controller-watermark";

function buildMeta(): ZCodeTaskMeta {
  return {
    taskId: TASK_ID,
    traceId: "trace-controller-watermark",
    title: "controller 已读水位",
    workspacePath: WORKSPACE_PATH,
    mode: "build",
    provider: "glm",
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

test("Window Controller 的 mark-read/mark-unread 透传 seen/terminal 水位", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const meta = buildMeta();
  const taskService = {
    listTasks: async () => [meta],
    listPinnedTasks: async () => [],
    listArchivedTasks: async () => [],
    setTaskUnread: async (params: Record<string, unknown>) => {
      calls.push(params);
      return {
        ...meta,
        ...(params.unread ? { unreadAt: 7_000 } : { unreadAt: undefined }),
        ...(typeof params.seenActivityAt === "number"
          ? { lastSeenActivityAt: params.seenActivityAt }
          : {}),
      };
    },
  } as unknown as IZCodeTaskService;

  const runtime = createWindowHostControllerRuntime({
    createId: () => "controller-watermark-id",
    resolveSource: () => ({
      scope: { kind: "local", workspacePath: WORKSPACE_PATH },
      taskService,
      sourceAvailability: "online",
    }),
  });
  const address = { taskId: TASK_ID, workspacePath: WORKSPACE_PATH };
  try {
    await runtime.service.listTaskList({
      kind: "active",
      workspaceScopes: [{ workspacePath: WORKSPACE_PATH }],
      sortBy: "updated",
    });

    const readResult = await runtime.service.mutateTask({
      address,
      mutation: {
        kind: "mark-read",
        expectedUnreadAt: 6_500,
        seenActivityAt: 8_000,
      },
    });
    assert.ok(readResult);
    assert.deepEqual(calls[0], {
      taskId: TASK_ID,
      workspacePath: WORKSPACE_PATH,
      unread: false,
      expectedUnreadAt: 6_500,
      seenActivityAt: 8_000,
    });

    const unreadResult = await runtime.service.mutateTask({
      address,
      mutation: { kind: "mark-unread", terminalActivityAt: 8_500 },
    });
    assert.ok(unreadResult);
    assert.deepEqual(calls[1], {
      taskId: TASK_ID,
      workspacePath: WORKSPACE_PATH,
      unread: true,
      terminalActivityAt: 8_500,
    });

    // null 是运行时绕过类型的显式值，必须原样透传给下游 adapter 拒绝，
    // 不能在 controller 层被当作省略而降级 legacy。
    type Mutation = Parameters<typeof runtime.service.mutateTask>[0]["mutation"];
    await runtime.service.mutateTask({
      address,
      mutation: { kind: "mark-read", seenActivityAt: null } as unknown as Mutation,
    });
    assert.deepEqual(calls[2], {
      taskId: TASK_ID,
      workspacePath: WORKSPACE_PATH,
      unread: false,
      seenActivityAt: null,
    });

    await runtime.service.mutateTask({
      address,
      mutation: { kind: "mark-unread", terminalActivityAt: null } as unknown as Mutation,
    });
    assert.deepEqual(calls[3], {
      taskId: TASK_ID,
      workspacePath: WORKSPACE_PATH,
      unread: true,
      terminalActivityAt: null,
    });
  } finally {
    runtime.dispose();
  }
});
