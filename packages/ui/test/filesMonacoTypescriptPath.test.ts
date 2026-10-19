import assert from "node:assert/strict";
import test from "node:test";
import {
  filesMonacoTypescriptWorkspaceScope,
  filesMonacoPathFromVirtualUri,
  filesMonacoVirtualPath,
  joinFilesAbsolutePath,
  normalizeFilesMonacoPath,
  parentDirFromPath,
} from "../src/files-workbench/filesMonacoTypescriptPath.js";
import type { FilesWorkspaceRef } from "../src/files-workbench/filesEditorTypes.js";

const localWorkspace: FilesWorkspaceRef = { workspacePath: "/repo" };
const remoteWorkspace: FilesWorkspaceRef = {
  workspacePath: "/repo",
  workspaceIdentity: "same-path-remote",
  workspaceRemoteSessionId: "session-1",
};

test("TypeScript resolver uses normalized POSIX paths independent of host OS", () => {
  assert.equal(normalizeFilesMonacoPath("C:\\repo\\src\\..\\index.ts"), "C:/repo/index.ts");
  assert.equal(joinFilesAbsolutePath("/repo/src", "../types/foo"), "/repo/types/foo");
  assert.equal(joinFilesAbsolutePath("C:/repo/src", "../types/foo"), "C:/repo/types/foo");
  assert.equal(
    normalizeFilesMonacoPath("\\\\server\\share\\repo\\file.ts"),
    "//server/share/repo/file.ts",
  );
  assert.equal(parentDirFromPath("/repo/src/index.ts"), "/repo/src");
  assert.equal(parentDirFromPath("/index.ts"), "/");
  assert.equal(parentDirFromPath("C:/index.ts"), "C:/");
});

test("same absolute path in different workspace scopes maps to distinct Monaco URIs", () => {
  assert.notEqual(
    filesMonacoTypescriptWorkspaceScope(localWorkspace),
    filesMonacoTypescriptWorkspaceScope(remoteWorkspace),
  );
  assert.notEqual(
    filesMonacoVirtualPath(localWorkspace, "/repo/src/index.ts"),
    filesMonacoVirtualPath(remoteWorkspace, "/repo/src/index.ts"),
  );
  assert.equal(
    filesMonacoVirtualPath(localWorkspace, "/repo/src/index.ts"),
    filesMonacoVirtualPath(localWorkspace, "/repo/src/../src/index.ts"),
  );
});

test("Go to Definition maps only matching virtual workspace URIs back to real paths", () => {
  assert.equal(
    filesMonacoPathFromVirtualUri(localWorkspace, {
      scheme: "file",
      path: filesMonacoVirtualPath(localWorkspace, "/repo/src/derive.ts"),
    }),
    "/repo/src/derive.ts",
  );
  assert.equal(
    filesMonacoPathFromVirtualUri(localWorkspace, {
      scheme: "file",
      path: filesMonacoVirtualPath(remoteWorkspace, "/repo/src/derive.ts"),
    }),
    undefined,
  );
  assert.equal(
    filesMonacoPathFromVirtualUri(localWorkspace, {
      scheme: "file",
      path: "/node_modules/typescript/lib/lib.es5.d.ts",
    }),
    undefined,
  );
  assert.equal(
    filesMonacoPathFromVirtualUri({ workspacePath: "C:/repo" }, {
      scheme: "file",
      path: filesMonacoVirtualPath({ workspacePath: "C:/repo" }, "C:/repo/src/derive.ts"),
    }),
    "C:/repo/src/derive.ts",
  );
});
