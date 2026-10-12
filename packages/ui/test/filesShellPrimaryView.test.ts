import assert from "node:assert/strict";
import test from "node:test";
import {
  FILES_TAB_ID,
  SETTINGS_TAB_ID,
  resolveWorkspaceShellPrimaryView,
} from "../src/store/tabStore.js";

test("主视图投影：设置、文件、任务互斥", () => {
  assert.equal(resolveWorkspaceShellPrimaryView(undefined), "tasks");
  assert.equal(
    resolveWorkspaceShellPrimaryView({ id: SETTINGS_TAB_ID, kind: "settings", label: "settings" }),
    "settings",
  );
  assert.equal(
    resolveWorkspaceShellPrimaryView({ id: FILES_TAB_ID, kind: "files", label: "files" }),
    "files",
  );
  assert.equal(
    resolveWorkspaceShellPrimaryView({
      id: "ws-1",
      kind: "workspace",
      label: "demo",
      workspacePath: "/tmp/demo",
    }),
    "tasks",
  );
});
