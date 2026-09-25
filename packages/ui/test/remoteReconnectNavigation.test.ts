import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";
import {
  isRemoteReconnectNavigationIntentCurrent,
  shouldActivateReconnectedWorkspace,
  type RemoteReconnectNavigationIntent,
} from "../src/root/remoteReconnectNavigation.js";
import { openRemoteWorkspaceFromHistoryEntry } from "../src/root/useRemoteWorkspaceHistory.js";
import { reconnectRemoteWorkspaceHistoryEntry } from "../src/root/reconnectRemoteWorkspaceHistoryEntry.js";
import { createTabStore } from "../src/store/tabStore.js";
import { buildWorkspaceSessionKey } from "../src/lib/remoteWorkspaceHistory.js";

const baseIntent: RemoteReconnectNavigationIntent = {
  activeTabId: "tab-a",
  activeWorkspacePath: "/workspace/a",
  activeWorkspaceIdentity: "remote:a",
  activeTaskId: "task-a",
  draftFocusVersion: 3,
};

test("重连导航 guard 只在所有导航字段仍一致时放行", () => {
  assert.equal(isRemoteReconnectNavigationIntentCurrent(baseIntent, { ...baseIntent }), true);
  assert.equal(
    isRemoteReconnectNavigationIntentCurrent(baseIntent, {
      ...baseIntent,
      activeTabId: "tab-b",
    }),
    false,
  );
  assert.equal(
    isRemoteReconnectNavigationIntentCurrent(baseIntent, {
      ...baseIntent,
      activeTaskId: "task-b",
    }),
    false,
  );
  assert.equal(
    isRemoteReconnectNavigationIntentCurrent(baseIntent, {
      ...baseIntent,
      draftFocusVersion: 4,
    }),
    false,
  );
});

test("自动重连不激活，显式导航才执行 intent guard", () => {
  assert.equal(shouldActivateReconnectedWorkspace(false), false);
  assert.equal(shouldActivateReconnectedWorkspace(true), true);
  assert.equal(
    shouldActivateReconnectedWorkspace(true, () => false),
    false,
  );
  assert.equal(
    shouldActivateReconnectedWorkspace(true, () => true),
    true,
  );
});

test("显式历史打开用非激活 tab 写入，导航 guard 仍能激活目标", async () => {
  const tabStore = createTabStore();
  tabStore.getState().addTab("/workspace/a", { workspaceIdentity: "remote:a" });
  tabStore.getState().addTab("/workspace/b", { workspaceIdentity: "remote:b" });
  const sessionEntry: RemoteWorkspaceSessionEntry = {
    kind: "remote",
    workspacePath: "/workspace/a",
    workspaceIdentity: "remote:a",
    target: { kind: "wsl" },
    lastOpenedAt: 0,
    lastConnectionStatus: "failed",
  };
  const activationCalls: string[] = [];
  let activePathAfterMetadataWrite: string | null = null;
  let activated = false;

  await openRemoteWorkspaceFromHistoryEntry({
    workspaceKey: buildWorkspaceSessionKey(sessionEntry),
    tabStoreApi: tabStore,
    getRemoteSessions: () => [sessionEntry],
    inflightReconnectWorkspaceKeys: new Set(),
    activateTabByPath: (workspacePath, options) => {
      activationCalls.push(workspacePath);
      return tabStore.getState().activateTabByPath(workspacePath, options);
    },
    setReconnectingRemoteWorkspaceKeys: () => {},
    loadCredential: async () => null,
    connectRemoteWorkspaceTarget: async () => "session-a",
    resolveRemoteWorkspaceCanonicalPath: async (_sessionId, workspacePath) => workspacePath,
    disposeRemoteWorkspaceSession: async () => {},
    bindRemoteWorkspaceSessionContext: async () => {},
    ensureWorkspaceTab: tabStore.getState().ensureWorkspaceTab,
    commitRemoteWorkspaceSessionMutation: async () => sessionEntry,
    resetLogsForWorkspaceKey: () => {},
    onWorkspaceActivated: () => {
      activated = true;
    },
    reconnectImpl: async (params) => {
      params.upsertWorkspaceTab("/workspace/a", {
        remoteSessionId: "session-a",
        workspaceIdentity: "remote:a",
      });
      activePathAfterMetadataWrite = tabStore.getState().activeWorkspacePath;
      if (params.isNavigationStillCurrent?.()) {
        const didActivate = params.activateTabByPath("/workspace/a", {
          workspaceIdentity: "remote:a",
        });
        if (didActivate) {
          params.onWorkspaceActivated?.({
            workspacePath: "/workspace/a",
            workspaceIdentity: "remote:a",
          });
        }
      }
    },
  });

  assert.equal(activePathAfterMetadataWrite, "/workspace/b");
  assert.deepEqual(activationCalls, ["/workspace/a"]);
  assert.equal(activated, true);
  assert.equal(tabStore.getState().activeWorkspacePath, "/workspace/a");
});

test("等待期间用户导航后，显式历史连接只恢复 metadata 不抢焦点", async () => {
  const tabStore = createTabStore();
  tabStore.getState().addTab("/workspace/a", { workspaceIdentity: "remote:a" });
  tabStore.getState().addTab("/workspace/b", { workspaceIdentity: "remote:b" });
  const sessionEntry: RemoteWorkspaceSessionEntry = {
    kind: "remote",
    workspacePath: "/workspace/a",
    workspaceIdentity: "remote:a",
    target: { kind: "wsl" },
    lastOpenedAt: 0,
    lastConnectionStatus: "failed",
  };
  let activationCalls = 0;
  let activePathAfterMetadataWrite: string | null = null;

  await openRemoteWorkspaceFromHistoryEntry({
    workspaceKey: buildWorkspaceSessionKey(sessionEntry),
    tabStoreApi: tabStore,
    getRemoteSessions: () => [sessionEntry],
    inflightReconnectWorkspaceKeys: new Set(),
    activateTabByPath: (workspacePath, options) => {
      activationCalls += 1;
      return tabStore.getState().activateTabByPath(workspacePath, options);
    },
    setReconnectingRemoteWorkspaceKeys: () => {},
    loadCredential: async () => null,
    connectRemoteWorkspaceTarget: async () => "session-a",
    resolveRemoteWorkspaceCanonicalPath: async (_sessionId, workspacePath) => workspacePath,
    disposeRemoteWorkspaceSession: async () => {},
    bindRemoteWorkspaceSessionContext: async () => {},
    ensureWorkspaceTab: tabStore.getState().ensureWorkspaceTab,
    commitRemoteWorkspaceSessionMutation: async () => sessionEntry,
    resetLogsForWorkspaceKey: () => {},
    reconnectImpl: async (params) => {
      params.upsertWorkspaceTab("/workspace/a", {
        remoteSessionId: "session-a",
        workspaceIdentity: "remote:a",
      });
      activePathAfterMetadataWrite = tabStore.getState().activeWorkspacePath;
      tabStore.getState().addTab("/workspace/c", { workspaceIdentity: "remote:c" });
      if (params.isNavigationStillCurrent?.()) {
        activationCalls += 1;
        params.activateTabByPath("/workspace/a", { workspaceIdentity: "remote:a" });
      }
    },
  });

  assert.equal(activePathAfterMetadataWrite, "/workspace/b");
  assert.equal(activationCalls, 0);
  assert.equal(tabStore.getState().activeWorkspacePath, "/workspace/c");
});

test("真实恢复 helper 默认静默恢复，只有显式选项才激活 workspace", async () => {
  const sessionEntry: RemoteWorkspaceSessionEntry = {
    kind: "remote",
    workspacePath: "/workspace/a",
    workspaceIdentity: "remote:a",
    target: { kind: "wsl" },
    lastOpenedAt: 0,
    lastConnectionStatus: "failed",
  };
  let activationCalls = 0;
  let draftCalls = 0;

  const run = async (activateWorkspaceAfterReconnect: boolean, navigationStillCurrent = true) => {
    await reconnectRemoteWorkspaceHistoryEntry({
      sessionEntry,
      activateTabByPath: () => {
        activationCalls += 1;
        return true;
      },
      setReconnectingRemoteWorkspaceKeys: () => {},
      loadCredential: async () => null,
      connectRemoteWorkspaceTarget: async () => "session-a",
      resolveRemoteWorkspaceCanonicalPath: async (_sessionId, workspacePath) => workspacePath,
      disposeRemoteWorkspaceSession: async () => {},
      bindRemoteWorkspaceSessionContext: async () => {},
      bindRemoteWorkspacePath: () => {},
      bindRemoteWorkspaceIdentity: () => {},
      upsertWorkspaceTab: () => {},
      commitRemoteWorkspaceSessionMutation: async (mutation) => mutation,
      getRemoteSessions: () => [sessionEntry],
      logger: { warn: () => undefined },
      toast: () => undefined,
      shouldKeepReconnectedWorkspace: () => true,
      isNavigationStillCurrent: () => navigationStillCurrent,
      onWorkspaceActivated: () => {
        draftCalls += 1;
      },
      options: {
        activateWorkspaceAfterReconnect,
        showErrorToast: false,
      },
    });
  };

  await run(false);
  assert.equal(activationCalls, 0);
  assert.equal(draftCalls, 0);

  await run(true);
  assert.equal(activationCalls, 1);
  assert.equal(draftCalls, 1);

  await run(true, false);
  assert.equal(activationCalls, 1);
  assert.equal(draftCalls, 1);
});
