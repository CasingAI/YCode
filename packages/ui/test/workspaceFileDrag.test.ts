import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceFileComposerMention,
  readWorkspaceFileDragPayload,
  serializeWorkspaceFileDragPayload,
  WORKSPACE_FILE_DRAG_MIME,
  type WorkspaceFileDragPayload,
} from "../src/lib/workspaceFileDrag.js";

const file: WorkspaceFileDragPayload = {
  type: "file",
  workspacePath: "/work",
  path: "/work/src/app.ts",
  relativePath: "src/app.ts",
  name: "app.ts",
};

test("文件树拖拽保留工作区身份，普通文件拖拽不解析为引用", () => {
  const payload = { ...file, workspaceIdentity: "workspace-a" };
  const dataTransfer = {
    types: [WORKSPACE_FILE_DRAG_MIME, "text/plain"],
    getData: (type: string) =>
      type === WORKSPACE_FILE_DRAG_MIME ? serializeWorkspaceFileDragPayload(payload) : "app.ts",
  } as DataTransfer;
  assert.deepEqual(readWorkspaceFileDragPayload(dataTransfer), payload);
  assert.equal(
    readWorkspaceFileDragPayload({ ...dataTransfer, types: ["Files"] } as DataTransfer),
    null,
  );
});

test("同工作区拖入文件和目录仍生成相对路径引用", () => {
  assert.equal(
    createWorkspaceFileComposerMention(file, "/work").markdown,
    "[app.ts](./src/app.ts)",
  );
  const directory = createWorkspaceFileComposerMention(
    { ...file, type: "directory", path: "/work/src", relativePath: "src", name: "src" },
    "/work",
  );
  assert.equal(directory.markdown, "[src](./src/)");
  assert.equal(directory.data.kind, "directory");
});

test("同路径不同身份的工作区拖拽使用绝对路径，保持引用隔离", () => {
  const payload = { ...file, workspaceIdentity: "workspace-a" };
  assert.equal(
    createWorkspaceFileComposerMention(payload, "/work", "workspace-a").value,
    "src/app.ts",
  );
  const mention = createWorkspaceFileComposerMention(payload, "/work", "workspace-b");
  assert.equal(mention.markdown, "[app.ts](/work/src/app.ts)");
  assert.equal(mention.data.path, "/work/src/app.ts");
  assert.equal(mention.value, "/work/src/app.ts");
});
