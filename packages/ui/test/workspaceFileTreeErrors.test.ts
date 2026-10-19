import assert from "node:assert/strict";
import test from "node:test";
import { flattenWorkspaceFileTreeRows } from "../src/workspace-file-tree/model.js";

const rootPath = "/work";
const directoryPath = "/work/src";
const filePath = "/work/src/derive.ts";
const childrenByDirectory = new Map([
  [rootPath, [{ path: directoryPath, name: "src", type: "directory" as const, depth: 0 }]],
  [directoryPath, [{ path: filePath, name: "derive.ts", type: "file" as const, depth: 1 }]],
]);

function rows(errorByDirectory: Map<string, Error>) {
  return flattenWorkspaceFileTreeRows({
    rootPath,
    childrenByDirectory,
    expandedPaths: new Set([directoryPath]),
    loadedDirectoryPaths: new Set([directoryPath]),
    loadingDirectoryPaths: new Set(),
    errorByDirectory,
  });
}

test("a directory read error is not shown on an ordinary file", () => {
  const fileError = new Error("not a directory");
  const result = rows(new Map([[filePath, fileError]]));
  assert.equal(result.find((row) => row.path === filePath)?.error, null);
});

test("directory read failure has an error; retry success removes the marker", () => {
  const failure = new Error("permission denied");
  const failed = rows(new Map([[directoryPath, failure]]));
  assert.equal(failed.find((row) => row.path === directoryPath)?.error, failure);
  assert.equal(failed.find((row) => row.path === filePath)?.error, null);

  const recovered = rows(new Map());
  assert.equal(recovered.find((row) => row.path === directoryPath)?.error, null);
});
