import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ChannelClient, ChannelServer, ProxyChannel, createQueuePair } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import type { IFileService, WorkspaceFileListOptions } from "../src/file/file.js";
import { createFileService } from "../src/file/fileService.js";

/**
 * 真实 RPC 集成测试：ChannelServer/ChannelClient 走内存队列传输，
 * createFileService 挂在既有 ServiceChannels.File 上，不 mock 文件服务本身。
 * 覆盖 listWorkspaceFilesLength / Range 的用途与忽略选项经 typed RPC 后的透传，
 * 以及分块读取与 fetch 分块语义一致（每块复用同一索引）。
 */

interface RpcFileService {
  fileService: IFileService;
  dispose(): void;
}

function connectFileService(service: IFileService = createFileService()): RpcFileService {
  const [clientProtocol, serverProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "file-index-rpc");
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

async function withWorkspace<T>(run: (rootPath: string) => Promise<T>): Promise<T> {
  const rootPath = await mkdtemp(join(tmpdir(), "zcode-file-index-rpc-"));
  try {
    return await run(rootPath);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function write(rootPath: string, relativePath: string): Promise<void> {
  const path = join(rootPath, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "");
}

async function fetchPacked(
  service: IFileService,
  rootPath: string,
  options: WorkspaceFileListOptions & { refresh?: boolean },
): Promise<string[]> {
  const rangeOptions: WorkspaceFileListOptions = {
    workspaceIdentity: options.workspaceIdentity,
    purpose: options.purpose,
    includeIgnored: options.includeIgnored,
  };
  const totalLength = await service.listWorkspaceFilesLength({ rootPath, ...options });
  let packed = "";
  // 小分块刻意制造多次 Range 调用，验证每块都带上同一组选项。
  for (let offset = 0; offset < totalLength; offset += 32) {
    packed += await service.listWorkspaceFilesRange({
      rootPath,
      offset,
      length: 32,
      ...rangeOptions,
    });
  }
  return unpackWorkspaceFileEntries(packed, rootPath).map(
    (entry) => `${entry.type}:${entry.relativePath}`,
  );
}

test("RPC 分块读取保留 file-browser / includeIgnored 选项并返回同一语义", async () => {
  await withWorkspace(async (rootPath) => {
    await write(rootPath, "src/app.ts");
    await write(rootPath, ".env");
    await write(rootPath, "ignored-dir/secret.txt");
    await writeFile(join(rootPath, ".zcodeignore"), "ignored-dir/\n", "utf8");

    const rpc = connectFileService();
    try {
      const options = {
        workspaceIdentity: "remote-workspace-identity",
        purpose: "file-browser" as const,
        includeIgnored: true,
        refresh: true,
      };
      const all = await fetchPacked(rpc.fileService, rootPath, options);
      assert.ok(all.includes("file:.env"));
      assert.ok(all.includes("file:ignored-dir/secret.txt"));
      assert.ok(all.includes("file:.zcodeignore"));

      const defaultBrowser = await fetchPacked(rpc.fileService, rootPath, {
        workspaceIdentity: "remote-workspace-identity",
        purpose: "file-browser",
      });
      assert.ok(defaultBrowser.includes("file:.env"));
      assert.ok(!defaultBrowser.includes("file:ignored-dir/secret.txt"));

      // 旧用途经 RPC 仍保持原语义：不带浏览器选项时不能看到 .env。
      const legacy = await fetchPacked(rpc.fileService, rootPath, {
        workspaceIdentity: "remote-workspace-identity",
        refresh: true,
      });
      assert.ok(!legacy.includes("file:.env"));
      assert.ok(legacy.includes("file:src/app.ts"));
    } finally {
      rpc.dispose();
    }
  });
});

test("RPC 的 Range 使用与 Length 相同的身份与用途，跨分块结果一致", async () => {
  await withWorkspace(async (rootPath) => {
    await write(rootPath, ".zcodeignore");
    for (let index = 0; index < 40; index += 1) {
      await write(rootPath, `items/item-${String(index).padStart(2, "0")}.txt`);
    }

    const rpc = connectFileService();
    try {
      const options: WorkspaceFileListOptions = {
        workspaceIdentity: "chunk-identity",
        purpose: "file-browser",
      };
      const totalLength = await rpc.fileService.listWorkspaceFilesLength({ rootPath, ...options });
      assert.ok(totalLength > 32, "fixture 应产生多个分块");

      let packed = "";
      for (let offset = 0; offset < totalLength; offset += 32) {
        packed += await rpc.fileService.listWorkspaceFilesRange({
          rootPath,
          offset,
          length: 32,
          ...options,
        });
      }
      const entries = unpackWorkspaceFileEntries(packed, rootPath).map(
        (entry) => entry.relativePath,
      );
      assert.equal(entries.filter((path) => path.startsWith("items/item-")).length, 40);
      assert.ok(entries.includes(".zcodeignore"));
    } finally {
      rpc.dispose();
    }
  });
});
