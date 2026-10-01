import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeSlashCommand } from "@zcode/shared";
import { refreshWorkspaceSlashCommandsAfterBindingChange } from "../src/settings/refreshWorkspaceSlashCommands.js";
import { useZCodeSessionStore } from "../src/store/zcodeSessionStore.js";
import { getWorkspaceState } from "../src/store/zcodeSessionStoreSelectors.js";

// 绑定写盘后的目录刷新（docs/specs/command-model-binding.md）：现拉一次
// readWorkspacePresentation 并整表写回 zcodeSessionStore；刷新失败只降级，
// 不让设置写入的成功反馈被吞掉。

const BINDING = { providerId: "zcode", modelId: "glm-5.3" };
const WORKSPACE = "/tmp/ws-binding";
const IDENTITY = "ws-identity-1";

function fakeService(
  impl: (request: { workspacePath: string; workspaceIdentity?: string }) => Promise<unknown>,
) {
  return {
    readWorkspacePresentation: impl,
  } as Parameters<typeof refreshWorkspaceSlashCommandsAfterBindingChange>[0]["zcodeSessionService"];
}

function currentSlashCommands(workspacePath = WORKSPACE, workspaceIdentity = IDENTITY) {
  return getWorkspaceState(useZCodeSessionStore.getState(), workspacePath, workspaceIdentity)
    .slashCommands;
}

test("绑定变更后现拉目录并整表写回 store", async () => {
  const refreshed: ZCodeSlashCommand[] = [
    {
      name: "compact",
      description: "compact",
      inputHint: "/compact",
      source: "builtin",
      modelSelectionOverride: BINDING,
    },
  ];
  const requests: Array<{ workspacePath: string; workspaceIdentity?: string }> = [];
  await refreshWorkspaceSlashCommandsAfterBindingChange({
    workspacePath: WORKSPACE,
    workspaceIdentity: IDENTITY,
    zcodeSessionService: fakeService(async (request) => {
      requests.push(request);
      return { mode: "default", slashCommands: refreshed };
    }),
  });
  assert.deepEqual(requests, [{ workspacePath: WORKSPACE, workspaceIdentity: IDENTITY }]);
  assert.deepEqual(currentSlashCommands(), refreshed);
});

test("readWorkspacePresentation 失败只降级：不上抛，目录保持旧值", async () => {
  useZCodeSessionStore.getState().setSlashCommands(WORKSPACE, [], IDENTITY);
  await assert.doesNotReject(
    refreshWorkspaceSlashCommandsAfterBindingChange({
      workspacePath: WORKSPACE,
      workspaceIdentity: IDENTITY,
      zcodeSessionService: fakeService(async () => {
        throw new Error("rpc down");
      }),
    }),
  );
  assert.deepEqual(currentSlashCommands(), []);
});

test("旧 CLI 的 presentation 不带 slashCommands 字段：保留现状，不清空目录", async () => {
  const existing: ZCodeSlashCommand[] = [
    { name: "init", description: "init", inputHint: "/init", source: "builtin" },
  ];
  useZCodeSessionStore.getState().setSlashCommands(WORKSPACE, existing, IDENTITY);
  await refreshWorkspaceSlashCommandsAfterBindingChange({
    workspacePath: WORKSPACE,
    workspaceIdentity: IDENTITY,
    zcodeSessionService: fakeService(async () => ({ mode: "default" })),
  });
  assert.deepEqual(currentSlashCommands(), existing);
});
