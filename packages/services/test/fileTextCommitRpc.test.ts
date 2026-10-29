import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelClient, ChannelServer, ProxyChannel, createQueuePair } from "@zcode/rpc";
import {
  FILE_TEXT_COMMIT_CONFLICT_CODE,
  FILE_TEXT_INVALID_PATCH_CODE,
  ServiceChannels,
} from "@zcode/shared";
import type { IFileService } from "../src/file/file.js";
import { createFileService } from "../src/file/fileService.js";

interface RpcFileService {
  fileService: IFileService;
  dispose(): void;
}

function connectFileService(service: IFileService = createFileService()): RpcFileService {
  const [clientProtocol, serverProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "file-text-commit-rpc");
  server.registerChannel(ServiceChannels.File, ProxyChannel.fromService(service));
  const client = new ChannelClient(clientProtocol);
  const fileService = ProxyChannel.toService<IFileService>(client.getChannel(ServiceChannels.File));
  return {
    fileService,
    dispose() {
      client.dispose();
      server.dispose();
    },
  };
}

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-file-commit-rpc-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("RPC 透传 commitTextFile full / patches 结果", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "rpc.txt");
    await writeFile(path, "hello", "utf8");
    const rpc = connectFileService();
    try {
      const first = await rpc.fileService.readTextFileWindow({ path, offset: 0, length: 8 });
      const full = await rpc.fileService.commitTextFile({
        path,
        expectedVersion: first.version,
        write: { kind: "full", text: "hello world" },
      });
      assert.equal(full.path, path);
      assert.equal(full.totalBytes, Buffer.byteLength("hello world"));
      assert.equal(await readFile(path, "utf8"), "hello world");

      const patched = await rpc.fileService.commitTextFile({
        path,
        expectedVersion: full.version,
        write: {
          kind: "patches",
          patches: [{ offset: 5, deleteBytes: 6, text: " 中文" }],
        },
      });
      assert.equal(await readFile(path, "utf8"), "hello 中文");
      assert.equal(patched.totalBytes, Buffer.byteLength("hello 中文"));
    } finally {
      rpc.dispose();
    }
  });
});

test("RPC 透传 commit 冲突错误码与 details.reason", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "conflict.txt");
    await writeFile(path, "disk", "utf8");
    const rpc = connectFileService();
    try {
      await assert.rejects(
        rpc.fileService.commitTextFile({
          path,
          expectedVersion: "stale-token",
          write: { kind: "full", text: "draft" },
        }),
        (error: unknown) => {
          const typed = error as { code?: unknown; details?: { reason?: unknown } };
          assert.equal(typed.code, FILE_TEXT_COMMIT_CONFLICT_CODE);
          assert.equal(typed.details?.reason, "target-version-mismatch");
          return true;
        },
      );

      await assert.rejects(
        rpc.fileService.commitTextFile({
          path,
          expectedVersion: null,
          write: { kind: "patches", patches: [] },
        }),
        (error: unknown) => {
          const typed = error as { code?: unknown };
          assert.equal(typed.code, FILE_TEXT_INVALID_PATCH_CODE);
          return true;
        },
      );
      assert.equal(await readFile(path, "utf8"), "disk");
    } finally {
      rpc.dispose();
    }
  });
});
