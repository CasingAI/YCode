import assert from "node:assert/strict";
import test from "node:test";
import type { WindowCommand } from "@zcode/shared";
import type { TabStore } from "../src/store/tabStore.js";
import { executeWindowCommand } from "../src/root/windowWorkspaceMirrorCommands.js";

// 跨窗口语义：手机镜像的是权威端那一个桌面窗口。
// 桌面端沿用既有 activateOrSetWorkspace 语义——同一目录不重复开在多个窗口，
// 已经在别的窗口打开时会激活那个窗口。权威端必须把这个结果回传，
// 镜像端据此提示"已在其它窗口打开"，而不是让用户看到"点了没反应"。

function createTabStoreStub() {
  const calls: string[] = [];
  const state = {
    ensureWorkspaceTab(path: string) {
      calls.push(`ensure:${path}`);
      return "tab-1";
    },
    activateTab(tabId: string) {
      calls.push(`activate:${tabId}`);
    },
    closeTab(tabId: string) {
      calls.push(`close:${tabId}`);
    },
    reorderWorkspaceTabs(from: number, to: number) {
      calls.push(`reorder:${from}->${to}`);
    },
    setWorkspaceExpanded(path: string, expanded: boolean) {
      calls.push(`expand:${path}:${String(expanded)}`);
    },
  };
  return { state, calls };
}

test("打开工作区落在本窗口：结果为 applied", async () => {
  const { state, calls } = createTabStoreStub();
  const command: WindowCommand = {
    commandId: "cmd-1",
    type: "open-workspace",
    workspacePath: "/tmp/project",
  };
  const outcome = await executeWindowCommand({
    command,
    tabStore: { getState: () => state } as unknown as TabStore,
    openWorkspace: async () => ({ openedInOtherWindow: false }),
  });

  assert.equal(outcome, "applied");
  assert.equal(calls.length, 0, "打开流程由窗口既有逻辑负责");
});

test("工作区已在其它桌面窗口打开：结果为 opened-in-other-window", async () => {
  const { state } = createTabStoreStub();
  const command: WindowCommand = {
    commandId: "cmd-2",
    type: "open-workspace",
    workspacePath: "/tmp/project",
  };
  const outcome = await executeWindowCommand({
    command,
    tabStore: { getState: () => state } as unknown as TabStore,
    openWorkspace: async () => ({ openedInOtherWindow: true }),
  });

  assert.equal(outcome, "opened-in-other-window");
});

test("打开流程没有返回结果时按 applied 处理：旧调用方不受影响", async () => {
  const { state } = createTabStoreStub();
  const command: WindowCommand = {
    commandId: "cmd-3",
    type: "open-workspace",
    workspacePath: "/tmp/project",
  };
  const outcome = await executeWindowCommand({
    command,
    tabStore: { getState: () => state } as unknown as TabStore,
    openWorkspace: async () => undefined,
  });

  assert.equal(outcome, "applied");
});

test("非打开类命令一律是 applied", async () => {
  const { state, calls } = createTabStoreStub();
  const command: WindowCommand = {
    commandId: "cmd-4",
    type: "set-workspace-expanded",
    workspacePath: "/tmp/project",
    expanded: true,
  };
  const outcome = await executeWindowCommand({
    command,
    tabStore: { getState: () => state } as unknown as TabStore,
  });

  assert.equal(outcome, "applied");
  assert.deepEqual(calls, ["expand:/tmp/project:true"]);
});
