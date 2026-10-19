import assert from "node:assert/strict";
import test from "node:test";
import {
  findLocalWorkspaceTabForFile,
  isFileInsideWorkspace,
  normalizeLocalFilePath,
} from "../src/root/openFilePathRouting.js";
import type { WorkspaceTabState } from "../src/store/tabStore.js";

function workspace(path: string, extra: Record<string, unknown> = {}): WorkspaceTabState {
  return {
    kind: "workspace",
    id: path,
    workspacePath: path,
    ...extra,
  } as unknown as WorkspaceTabState;
}

test("file path matching respects path boundaries and the most specific local workspace", () => {
  const tabs = [workspace("/projects/app"), workspace("/projects/app/packages/ui")];
  assert.equal(isFileInsideWorkspace("/projects/app/src/main.ts", "/projects/app"), true);
  assert.equal(isFileInsideWorkspace("/projects/application/main.ts", "/projects/app"), false);
  assert.equal(
    findLocalWorkspaceTabForFile("/projects/app/packages/ui/src/index.ts", tabs),
    tabs[1],
  );
});

test("remote workspaces are not selected for local OS file paths; Windows paths compare case-insensitively", () => {
  const tabs = [
    workspace("C:\\Users\\Test\\Project"),
    workspace("C:\\Users\\Test\\Project", {
      workspaceIdentity: "remote",
      remoteSessionId: "session",
    }),
  ];
  assert.equal(
    findLocalWorkspaceTabForFile("c:\\users\\test\\project\\src\\main.ts", tabs),
    tabs[0],
  );
  assert.equal(
    normalizeLocalFilePath("\\\\?\\C:\\Users\\Test\\Project\\"),
    "C:/Users/Test/Project",
  );
});
