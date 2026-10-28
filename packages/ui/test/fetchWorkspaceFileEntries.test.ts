import assert from "node:assert/strict";
import test from "node:test";
import { WORKSPACE_FILE_ENTRIES_CHUNK_SIZE } from "@zcode/shared/workspaceFileEntriesCodec";
import type { WorkspaceFileListLengthParams, WorkspaceFileListRangeParams } from "@zcode/services";
import { fetchWorkspaceFileEntriesPacked } from "../src/workspace-file-search/fetchWorkspaceFileEntries.js";

/**
 * 分块拉取的选项转发：Length 收到 refresh，Range 必须收到同一组
 * 身份/用途/忽略选项且永远不收到 refresh；多个分块拼接为完整 packed。
 */

test("fetchWorkspaceFileEntriesPacked 将浏览器选项转发给 Length 与每个 Range", async () => {
  const lengthCalls: WorkspaceFileListLengthParams[] = [];
  const rangeCalls: WorkspaceFileListRangeParams[] = [];
  const totalLength = WORKSPACE_FILE_ENTRIES_CHUNK_SIZE + 16;
  const service = {
    async listWorkspaceFilesLength(params: WorkspaceFileListLengthParams): Promise<number> {
      lengthCalls.push(params);
      return totalLength;
    },
    async listWorkspaceFilesRange(params: WorkspaceFileListRangeParams): Promise<string> {
      rangeCalls.push(params);
      return "x".repeat(Math.min(params.length, totalLength - params.offset));
    },
  };

  const packed = await fetchWorkspaceFileEntriesPacked(service, "/workspace", {
    workspaceIdentity: "identity-1",
    purpose: "file-browser",
    includeIgnored: true,
    refresh: true,
  });

  assert.equal(packed.length, totalLength);
  assert.deepEqual(lengthCalls, [
    {
      rootPath: "/workspace",
      workspaceIdentity: "identity-1",
      purpose: "file-browser",
      includeIgnored: true,
      refresh: true,
    },
  ]);
  assert.equal(rangeCalls.length, 2);
  assert.deepEqual(rangeCalls[0], {
    rootPath: "/workspace",
    offset: 0,
    length: WORKSPACE_FILE_ENTRIES_CHUNK_SIZE,
    workspaceIdentity: "identity-1",
    purpose: "file-browser",
    includeIgnored: true,
  });
  assert.deepEqual(rangeCalls[1], {
    rootPath: "/workspace",
    offset: WORKSPACE_FILE_ENTRIES_CHUNK_SIZE,
    length: WORKSPACE_FILE_ENTRIES_CHUNK_SIZE,
    workspaceIdentity: "identity-1",
    purpose: "file-browser",
    includeIgnored: true,
  });
  for (const call of rangeCalls) {
    assert.equal("refresh" in call, false);
  }
});

test("省略第三参保持旧文件引用调用形态", async () => {
  const lengthCalls: WorkspaceFileListLengthParams[] = [];
  const rangeCalls: WorkspaceFileListRangeParams[] = [];
  const service = {
    async listWorkspaceFilesLength(params: WorkspaceFileListLengthParams): Promise<number> {
      lengthCalls.push(params);
      return 4;
    },
    async listWorkspaceFilesRange(params: WorkspaceFileListRangeParams): Promise<string> {
      rangeCalls.push(params);
      return "abcd";
    },
  };

  const packed = await fetchWorkspaceFileEntriesPacked(service, "/workspace");
  assert.equal(packed, "abcd");
  assert.deepEqual(lengthCalls, [
    {
      rootPath: "/workspace",
      workspaceIdentity: undefined,
      purpose: undefined,
      includeIgnored: undefined,
      refresh: undefined,
    },
  ]);
  assert.deepEqual(rangeCalls, [
    {
      rootPath: "/workspace",
      offset: 0,
      length: WORKSPACE_FILE_ENTRIES_CHUNK_SIZE,
      workspaceIdentity: undefined,
      purpose: undefined,
      includeIgnored: undefined,
    },
  ]);
});
