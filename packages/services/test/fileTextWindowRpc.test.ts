import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelClient, ChannelServer, ProxyChannel, createQueuePair } from "@zcode/rpc";
import {
  FILE_TEXT_WINDOW_CHANGED_CODE,
  FILE_TEXT_WINDOW_MAX_BYTES,
  ServiceChannels,
} from "@zcode/shared";
import type { IFileService } from "../src/file/file.js";
import { createFileService } from "../src/file/fileService.js";

/**
 * 真实 RPC 集成测试：ChannelServer/ChannelClient 走内存队列传输，
 * createFileService 挂在既有 ServiceChannels.File 上，不 mock 文件服务本身。
 * 只覆盖 readTextFileWindow 经 typed RPC 后的字段与错误码透传。
 */

interface RpcFileService {
  fileService: IFileService;
  dispose(): void;
}

function connectFileService(service: IFileService = createFileService()): RpcFileService {
  const [clientProtocol, serverProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "file-text-window-rpc");
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
  const directory = await mkdtemp(join(tmpdir(), "zcode-file-window-rpc-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeSparseFile(
  path: string,
  totalBytes: number,
  header: Buffer,
  tail: Buffer,
): Promise<void> {
  const handle = await open(path, "w+");
  try {
    await handle.truncate(totalBytes);
    await handle.write(header, 0, header.length, 0);
    await handle.write(tail, 0, tail.length, totalBytes - tail.length);
  } finally {
    await handle.close();
  }
}

test(
  "RPC 透传 >1GiB 稀疏文本窗口的首/中/尾 bytes、offset、total 与 version",
  { timeout: 60_000 },
  async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "sparse-1g.txt");
      const totalBytes = 1024 * 1024 * 1024 + 4096;
      const header = Buffer.alloc(64 * 1024, 0x20);
      Buffer.from("SPARSE HEADER TEXT\n".repeat(512), "utf8").copy(header);
      const marker = "\nTAIL_MARKER_END\n";
      const tail = Buffer.alloc(FILE_TEXT_WINDOW_MAX_BYTES, 0x41);
      tail.write(marker, tail.length - Buffer.byteLength(marker), "utf8");
      await writeSparseFile(path, totalBytes, header, tail);

      const rpc = connectFileService();
      try {
        const head = await rpc.fileService.readTextFileWindow({
          path,
          offset: 0,
          length: FILE_TEXT_WINDOW_MAX_BYTES,
        });
        assert.equal(head.path, path);
        assert.equal(head.offset, 0);
        assert.equal(head.bytesRead, FILE_TEXT_WINDOW_MAX_BYTES);
        assert.equal(head.nextOffset, FILE_TEXT_WINDOW_MAX_BYTES);
        assert.equal(head.totalBytes, totalBytes);
        assert.equal(head.eof, false);
        assert.equal(head.isBinary, false);
        assert.ok(head.version.length > 0);
        assert.ok(head.content.startsWith("SPARSE HEADER TEXT\n"));

        // 中间窗口落在稀疏零区，验证 offset / totalBytes / version 原样透传。
        const middleOffset = Math.floor(totalBytes / 2);
        const middle = await rpc.fileService.readTextFileWindow({
          path,
          offset: middleOffset,
          length: 64,
        });
        assert.equal(middle.offset, middleOffset);
        assert.equal(middle.bytesRead, 64);
        assert.equal(middle.nextOffset, middleOffset + 64);
        assert.equal(middle.totalBytes, totalBytes);
        assert.equal(middle.version, head.version);
        assert.equal(middle.content, "\0".repeat(64));
        assert.equal(middle.eof, false);

        // 尾窗口只返回有界尾部，总大小和版本仍与首窗一致。
        const tailOffset = totalBytes - FILE_TEXT_WINDOW_MAX_BYTES;
        const tailWindow = await rpc.fileService.readTextFileWindow({
          path,
          offset: tailOffset,
          length: FILE_TEXT_WINDOW_MAX_BYTES,
        });
        assert.equal(tailWindow.offset, tailOffset);
        assert.equal(tailWindow.bytesRead, FILE_TEXT_WINDOW_MAX_BYTES);
        assert.equal(tailWindow.nextOffset, totalBytes);
        assert.equal(tailWindow.totalBytes, totalBytes);
        assert.equal(tailWindow.version, head.version);
        assert.equal(tailWindow.eof, true);
        assert.equal(tailWindow.isBinary, false);
        assert.ok(tailWindow.content.endsWith(marker));
      } finally {
        rpc.dispose();
      }
    });
  },
);

test("RPC 将 FILE_TEXT_WINDOW_CHANGED 错误码原样透传到调用方", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "changed.txt");
    const handle = await open(path, "w+");
    try {
      await handle.writeFile("current content\n", "utf8");
    } finally {
      await handle.close();
    }

    const rpc = connectFileService();
    try {
      const first = await rpc.fileService.readTextFileWindow({
        path,
        offset: 0,
        length: 64,
      });
      assert.ok(first.version.length > 0);

      await assert.rejects(
        rpc.fileService.readTextFileWindow({
          path,
          offset: 0,
          length: 64,
          expectedVersion: "stale-version-token",
        }),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          (error as { code?: unknown }).code === FILE_TEXT_WINDOW_CHANGED_CODE,
      );
    } finally {
      rpc.dispose();
    }
  });
});

test("RPC 对带 expectedVersion 的已删除文件返回 CHANGED 而非 ENOENT", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "deleted.txt");
    const rpc = connectFileService();
    try {
      await writeFile(path, "first window\n", "utf8");
      const first = await rpc.fileService.readTextFileWindow({
        path,
        offset: 0,
        length: 64,
      });
      assert.ok(first.version.length > 0);

      await rm(path);
      await assert.rejects(
        rpc.fileService.readTextFileWindow({
          path,
          offset: 0,
          length: 64,
          expectedVersion: first.version,
        }),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          (error as { code?: unknown }).code === FILE_TEXT_WINDOW_CHANGED_CODE,
      );

      await assert.rejects(
        rpc.fileService.readTextFileWindow({ path, offset: 0, length: 64 }),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          (error as { code?: unknown }).code === "ENOENT",
      );
    } finally {
      rpc.dispose();
    }
  });
});
