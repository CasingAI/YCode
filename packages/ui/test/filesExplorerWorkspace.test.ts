import assert from "node:assert/strict";
import test from "node:test";
import {
  filesDefaultSaveDirectory,
  filesExplorerWorkspaceOptions,
  findFilesExplorerWorkspaceOption,
} from "../src/files-workbench/filesExplorerWorkspace.js";
import { filesParentDirectory, filesSaveAsTargetPath } from "../src/files-workbench/filesSaveAsPath.js";
import type { WorkspaceTabState } from "../src/store/tabStore.js";

test("下拉候选项与已打开工作区 tab 同源，key 用身份隔离", () => {
  const tabs: WorkspaceTabState[] = [
    {
      id: "1",
      kind: "workspace",
      label: "alpha",
      workspacePath: "/tmp/alpha",
    },
    {
      id: "2",
      kind: "workspace",
      label: "beta",
      workspacePath: "/mnt/beta",
      workspaceIdentity: "ssh-beta",
      remoteSessionId: "sess-1",
    },
  ];
  const options = filesExplorerWorkspaceOptions(tabs);
  assert.deepEqual(
    options.map((option) => option.key),
    ["/tmp/alpha", "ssh-beta"],
  );
  assert.equal(findFilesExplorerWorkspaceOption(options, "ssh-beta")?.label, "beta");
});

test("新建保存默认目录：选中文件夹优先，否则工作区根", () => {
  assert.equal(
    filesDefaultSaveDirectory({
      selectedPath: "/tmp/alpha/src",
      selectedIsDirectory: true,
      workspaceRoot: "/tmp/alpha",
    }),
    "/tmp/alpha/src",
  );
  assert.equal(
    filesDefaultSaveDirectory({
      selectedPath: "/tmp/alpha/src/app.ts",
      selectedIsDirectory: false,
      workspaceRoot: "/tmp/alpha",
    }),
    "/tmp/alpha/src",
  );
  assert.equal(
    filesDefaultSaveDirectory({ workspaceRoot: "/tmp/alpha" }),
    "/tmp/alpha",
  );
});

test("另存为只拼接已存在目录与文件名，拒绝路径分隔符", () => {
  assert.equal(filesSaveAsTargetPath("/tmp/alpha", "note.md"), "/tmp/alpha/note.md");
  assert.equal(filesSaveAsTargetPath("/tmp/alpha", "../x"), undefined);
  assert.equal(filesSaveAsTargetPath("/tmp/alpha", "a/b.md"), undefined);
  assert.equal(filesParentDirectory("/tmp/alpha/src"), "/tmp/alpha");
  assert.equal(filesParentDirectory("/tmp"), undefined);
});
