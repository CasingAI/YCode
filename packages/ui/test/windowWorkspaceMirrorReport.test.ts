import assert from "node:assert/strict";
import test from "node:test";
import { createTabStore } from "../src/store/tabStore.js";
import { useZCodeSessionStore } from "../src/store/zcodeSessionStore.js";
import {
  buildWindowWorkspaceReport,
  buildWindowWorkspaceSignature,
  toMirroredWorkspaceSet,
} from "../src/root/windowWorkspaceMirrorReport.js";

const appearance = {
  theme: "dark" as const,
  interfaceMode: "office" as const,
  uiFontSizePx: 14,
};

test("权威端上报的快照带上每个工作区当前打开的会话与外观", () => {
  const store = createTabStore(null);
  store.getState().addTab("/repo/alpha");
  useZCodeSessionStore.getState().setActiveTaskId("/repo/alpha", "task-7");

  const report = buildWindowWorkspaceReport(store.getState(), 3, appearance);

  assert.equal(report.clientRevision, 3);
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0]!.workspacePath, "/repo/alpha");
  assert.equal(report.entries[0]!.activeTaskId, "task-7");
  assert.deepEqual(report.appearance, appearance);
});

test("签名只覆盖窗口结构，结构没变时签名保持一致", () => {
  const store = createTabStore(null);
  store.getState().addTab("/repo/alpha");
  const first = buildWindowWorkspaceReport(store.getState(), 1, appearance);
  const second = buildWindowWorkspaceReport(store.getState(), 2, appearance);

  assert.equal(buildWindowWorkspaceSignature(first), buildWindowWorkspaceSignature(second));
});

test("会话切换会改变签名", () => {
  const store = createTabStore(null);
  store.getState().addTab("/repo/alpha");
  const before = buildWindowWorkspaceReport(store.getState(), 1, appearance);
  useZCodeSessionStore.getState().setActiveTaskId("/repo/alpha", "task-9");
  const after = buildWindowWorkspaceReport(store.getState(), 2, appearance);

  assert.notEqual(buildWindowWorkspaceSignature(before), buildWindowWorkspaceSignature(after));
});

test("外观变化会改变签名", () => {
  const store = createTabStore(null);
  store.getState().addTab("/repo/alpha");
  const before = buildWindowWorkspaceReport(store.getState(), 1, appearance);
  const after = buildWindowWorkspaceReport(store.getState(), 2, {
    ...appearance,
    theme: "light",
  });

  assert.notEqual(buildWindowWorkspaceSignature(before), buildWindowWorkspaceSignature(after));
});

test("协议快照映射成 tabStore 可直接落地的集合", () => {
  const mirrored = toMirroredWorkspaceSet({
    revision: 4,
    entries: [
      {
        id: "tab-a",
        workspacePath: "/repo/alpha",
        workspaceIdentity: "alpha-identity",
        activeTaskId: "task-1",
      },
    ],
    activeEntryId: "tab-a",
    activeWorkspacePath: "/repo/alpha",
    activeWorkspaceIdentity: "alpha-identity",
    expandedWorkspacePaths: ["/repo/alpha"],
    appearance,
  });

  assert.equal(mirrored.revision, 4);
  assert.deepEqual(mirrored.entries, [
    {
      id: "tab-a",
      workspacePath: "/repo/alpha",
      workspaceIdentity: "alpha-identity",
    },
  ]);
  assert.equal(mirrored.activeEntryId, "tab-a");
  assert.deepEqual(mirrored.expandedWorkspacePaths, ["/repo/alpha"]);
});
