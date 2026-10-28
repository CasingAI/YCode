import assert from "node:assert/strict";
import test from "node:test";
import {
  isFilesWorkspaceLocalTarget,
  resolveFilesWorkspaceServices,
  resolveFilesWorkspaceTarget,
} from "../src/files-workbench/filesWorkspaceFileService.js";
import type { IServiceAccessor } from "@zcode/services";

function fakeServices(label: string): IServiceAccessor {
  return { label } as unknown as IServiceAccessor;
}

test("本地工作区走 base file 通道", () => {
  const base = fakeServices("base");
  const resolved = resolveFilesWorkspaceServices({
    workspace: { workspacePath: "/tmp/a" },
    baseServices: base,
    sessionsById: {},
    workspaceTabs: [{ workspacePath: "/tmp/a" }],
  });
  assert.equal((resolved as { label: string }).label, "base");
});

test("远程工作区必须落到已注册 session 的 file 通道", () => {
  const base = fakeServices("base");
  const remote = fakeServices("remote");
  const resolved = resolveFilesWorkspaceServices({
    workspace: {
      workspacePath: "/mnt/a",
      workspaceIdentity: "ssh-a",
      workspaceRemoteSessionId: "sess-1",
    },
    baseServices: base,
    sessionsById: { "sess-1": { services: remote } },
    workspaceTabs: [
      {
        workspacePath: "/mnt/a",
        workspaceIdentity: "ssh-a",
        remoteSessionId: "sess-1",
      },
    ],
  });
  assert.equal((resolved as { label: string }).label, "remote");
});

test("远程 session 缺失时不能回落到本机", () => {
  assert.throws(() =>
    resolveFilesWorkspaceServices({
      workspace: { workspacePath: "/mnt/a", workspaceIdentity: "ssh-a" },
      baseServices: fakeServices("base"),
      sessionsById: {},
      workspaceTabs: [{ workspacePath: "/mnt/a", workspaceIdentity: "ssh-a" }],
    }),
  );
});

test("原生选路准入与文件服务解析共用同一套本机 / 远程判定", () => {
  const local = resolveFilesWorkspaceTarget({
    workspace: { workspacePath: "/tmp/a" },
    workspaceTabs: [{ workspacePath: "/tmp/a" }],
  });
  assert.equal(local.remote, false);
  assert.equal(local.workspaceKey, "/tmp/a");
  assert.equal(
    isFilesWorkspaceLocalTarget({
      workspace: { workspacePath: "/tmp/a" },
      workspaceTabs: [{ workspacePath: "/tmp/a" }],
    }),
    true,
  );

  const remoteCases = [
    {
      workspace: { workspacePath: "/mnt/a", workspaceIdentity: "ssh-a" },
      tab: { workspacePath: "/mnt/a", workspaceIdentity: "ssh-a" },
    },
    {
      workspace: { workspacePath: "/mnt/a", workspaceRemoteSessionId: "sess-1" },
      tab: { workspacePath: "/mnt/a" },
    },
    {
      workspace: { workspacePath: "/mnt/a", workspaceIdentity: "  ssh-a  " },
      tab: { workspacePath: "/mnt/a", workspaceIdentity: "ssh-a" },
    },
    {
      workspace: { workspacePath: "/mnt/a" },
      tab: { workspacePath: "/mnt/a", remoteSessionId: "sess-1" },
    },
  ];
  for (const { workspace, tab } of remoteCases) {
    const target = resolveFilesWorkspaceTarget({ workspace, workspaceTabs: [tab] });
    assert.equal(target.remote, true);
    assert.equal(isFilesWorkspaceLocalTarget({ workspace, workspaceTabs: [tab] }), false);
  }
});

test("按身份 key 匹配标签，其他工作区的远程标记不影响本机目标", () => {
  const workspace = { workspacePath: "/tmp/a" };
  const target = resolveFilesWorkspaceTarget({
    workspace,
    workspaceTabs: [
      { workspacePath: "/tmp/b", workspaceIdentity: "ssh-b", remoteSessionId: "sess-b" },
      { workspacePath: "/tmp/a" },
    ],
  });
  assert.equal(target.remote, false);
  assert.equal(target.remoteSessionId, undefined);
});

test("远程 session 可从工作区自身或匹配标签取得", () => {
  const fromWorkspace = resolveFilesWorkspaceTarget({
    workspace: { workspacePath: "/mnt/a", workspaceRemoteSessionId: "sess-1" },
    workspaceTabs: [{ workspacePath: "/mnt/a", remoteSessionId: "sess-2" }],
  });
  assert.equal(fromWorkspace.remoteSessionId, "sess-1");

  const fromTab = resolveFilesWorkspaceTarget({
    workspace: { workspacePath: "/mnt/a" },
    workspaceTabs: [{ workspacePath: "/mnt/a", remoteSessionId: "sess-2" }],
  });
  assert.equal(fromTab.remoteSessionId, "sess-2");
});
