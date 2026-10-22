import assert from "node:assert/strict";
import test from "node:test";
import { useZCodeSessionStore } from "../src/store/zcodeSessionStore.js";

test("镜像端安装命令通道后，切换会话转交权威端执行", () => {
  const calls: Array<[string, string | null, string | undefined]> = [];
  useZCodeSessionStore.getState().setActiveTaskCommandSink({
    activateTask: (workspacePath, id, workspaceIdentity) => {
      calls.push([workspacePath, id, workspaceIdentity]);
    },
  });

  useZCodeSessionStore
    .getState()
    .setActiveTaskId("/repo/mirror-sink", "task-1");

  assert.deepEqual(calls, [["/repo/mirror-sink", "task-1", undefined]]);
  assert.equal(
    useZCodeSessionStore
      .getState()
      .getWorkspaceState("/repo/mirror-sink").activeTaskId,
    null,
  );
  useZCodeSessionStore.getState().setActiveTaskCommandSink(null);
});

test("应用权威端下发的当前会话会落地，但不写本端导航历史", () => {
  const store = useZCodeSessionStore.getState();
  const navBefore = store.taskNavHistory;

  store.applyMirroredActiveTaskId("/repo/mirror-apply", "task-2");

  assert.equal(
    useZCodeSessionStore
      .getState()
      .getWorkspaceState("/repo/mirror-apply").activeTaskId,
    "task-2",
  );
  assert.deepEqual(useZCodeSessionStore.getState().taskNavHistory, navBefore);
});

test("本地切换会话仍会写导航历史", () => {
  const store = useZCodeSessionStore.getState();
  const navBefore = store.taskNavHistory;

  store.setActiveTaskId("/repo/mirror-local", "task-3");

  assert.equal(
    useZCodeSessionStore
      .getState()
      .getWorkspaceState("/repo/mirror-local").activeTaskId,
    "task-3",
  );
  assert.notDeepEqual(useZCodeSessionStore.getState().taskNavHistory, navBefore);
});
