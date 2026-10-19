import assert from "node:assert/strict";
import test from "node:test";
import { readFilesEditorSession } from "../src/files-workbench/filesEditorPersistence.js";
import { filesFileBufferId } from "../src/files-workbench/filesEditorModel.js";
import type { FilesWorkspaceRef } from "../src/files-workbench/filesEditorTypes.js";

const workspace: FilesWorkspaceRef = { workspacePath: "/workspace" };

test("恢复旧会话时将重复标签 ID 归一化，避免重复创建编辑器视图", () => {
  const id = filesFileBufferId(workspace, "/workspace/src/hostCapability.ts");
  const tab = { id, kind: "text" as const, path: "/workspace/src/hostCapability.ts", workspace };
  const raw = JSON.stringify({
    version: 1,
    activeId: id,
    openFileIds: Array.from({ length: 103 }, () => id),
    openTabs: Array.from({ length: 103 }, () => tab),
    drafts: [],
  });
  const session = readFilesEditorSession({ getItem: () => raw, setItem: () => undefined });

  assert.ok(session);
  assert.deepEqual(session.openFileIds, [id]);
  assert.deepEqual(
    session.openTabs.map((entry) => entry.id),
    [id],
  );
  assert.equal(session.activeId, id);
});

test("恢复会话时丢弃没有对应标签或草稿的 ID，并保留未列入 openFileIds 的脏草稿", () => {
  const id = filesFileBufferId(workspace, "/workspace/src/dirty.ts");
  const raw = JSON.stringify({
    version: 1,
    activeId: "file:missing",
    openFileIds: ["file:missing", id, id],
    openTabs: [],
    drafts: [
      {
        id,
        path: "/workspace/src/dirty.ts",
        title: "dirty.ts",
        text: "unsaved",
        savedText: "saved",
        workspace,
        untitled: false,
      },
    ],
  });
  const session = readFilesEditorSession({ getItem: () => raw, setItem: () => undefined });

  assert.ok(session);
  assert.deepEqual(session.openFileIds, [id]);
  assert.equal(session.activeId, id);
  assert.equal(session.drafts.length, 1);
});
