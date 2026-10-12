import assert from "node:assert/strict";
import test from "node:test";
import { resolveFilesWorkspaceServices } from "../src/files-workbench/filesWorkspaceFileService.js";
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
