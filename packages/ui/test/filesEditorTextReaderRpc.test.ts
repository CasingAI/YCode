import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelClient, ChannelServer, ProxyChannel, createQueuePair } from "@zcode/rpc";
import type { IFileService } from "@zcode/services";
import { createFileService } from "@zcode/services/node";
import { FILE_TEXT_WINDOW_MAX_BYTES, ServiceChannels } from "@zcode/shared";
import {
  FILES_EDITABLE_TEXT_MAX_BYTES,
  readFilesTextForOpen,
} from "../src/files-workbench/filesEditorTextReader.js";

/**
 * 真实 RPC 链路上的 UI 读取决策：UI helper 收到的是 ProxyChannel 代理的 IFileService，
 * 文件服务由 @zcode/services/node 的真实 createFileService 提供并挂在 ServiceChannels.File。
 * 不 mock 文件字节，也不伪造窗口结果。
 */

interface RpcFileService {
  fileService: IFileService;
  windowReads(): number;
  dispose(): void;
}

function connectFileService(): RpcFileService {
  const owner = createFileService();
  let windowReads = 0;
  // 只计数，不改写任何返回值；确认 UI helper 通过 RPC 实际发出的窗口读次数。
  const counted = new Proxy(owner, {
    get(target, property, receiver) {
      if (property === "readTextFileWindow") {
        return async (params: {
          path: string;
          offset?: number;
          length?: number;
          expectedVersion?: string;
        }) => {
          windowReads += 1;
          return target.readTextFileWindow(params);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as IFileService;

  const [clientProtocol, serverProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "file-text-window-rpc-ui");
  server.registerChannel(ServiceChannels.File, ProxyChannel.fromService(counted));
  const client = new ChannelClient(clientProtocol);
  const fileService = ProxyChannel.toService<IFileService>(client.getChannel(ServiceChannels.File));

  return {
    fileService,
    windowReads: () => windowReads,
    dispose() {
      client.dispose();
      server.dispose();
    },
  };
}

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-file-window-rpc-ui-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeSparseFile(path: string, totalBytes: number, header: Buffer): Promise<void> {
  const handle = await open(path, "w+");
  try {
    await handle.truncate(totalBytes);
    await handle.write(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
}

test(
  "经 RPC 调用 readFilesTextForOpen 完整读取 >256KiB 且 <=8MiB 文本，无尾损",
  { timeout: 60_000 },
  async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "editable.txt");
      const head = "开头-多字节-é中😀\n";
      const body = "0123456789abcdef".repeat(1024).repeat(50);
      const tail = "\nTAIL_MARKER_END_无尾损_😀\n";
      const text = head + body + tail;
      const totalBytes = Buffer.byteLength(text);
      assert.ok(totalBytes > FILE_TEXT_WINDOW_MAX_BYTES);
      assert.ok(totalBytes <= FILES_EDITABLE_TEXT_MAX_BYTES);
      await writeFile(path, text, "utf8");

      const rpc = connectFileService();
      try {
        const result = await readFilesTextForOpen(rpc.fileService, path);
        if (result.mode !== "editable") {
          assert.fail(`预期 editable，实际 ${result.mode}`);
        }
        assert.equal(result.totalBytes, totalBytes);
        assert.equal(result.text, text);
        assert.ok(result.text.endsWith(tail));
        // 完整读取必须逐窗经过 RPC，而不是只读首窗。
        assert.ok(rpc.windowReads() > 1);
      } finally {
        rpc.dispose();
      }
    });
  },
);

test(
  "经 RPC 调用 readFilesTextForOpen 对 >1GiB 文本进入只读模式且只读首窗一次",
  { timeout: 60_000 },
  async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "sparse-1g.txt");
      const totalBytes = 1024 * 1024 * 1024 + 4096;
      const header = Buffer.alloc(64 * 1024, 0x20);
      Buffer.from("LARGE HEADER TEXT\n".repeat(512), "utf8").copy(header);
      await writeSparseFile(path, totalBytes, header);

      const rpc = connectFileService();
      try {
        const result = await readFilesTextForOpen(rpc.fileService, path);
        if (result.mode !== "large-text") {
          assert.fail(`预期 large-text，实际 ${result.mode}`);
        }
        assert.equal(result.totalBytes, totalBytes);
        assert.equal(result.version, result.firstWindow.version);
        assert.equal(result.firstWindow.offset, 0);
        assert.equal(result.firstWindow.bytesRead, FILE_TEXT_WINDOW_MAX_BYTES);
        assert.equal(result.firstWindow.totalBytes, totalBytes);
        assert.equal(result.firstWindow.eof, false);
        assert.equal(result.firstWindow.isBinary, false);
        assert.ok(result.firstWindow.content.startsWith("LARGE HEADER TEXT\n"));
        // 只读大文件不得扫描全文：决策阶段只发起一次首窗读取。
        assert.equal(rpc.windowReads(), 1);
      } finally {
        rpc.dispose();
      }
    });
  },
);
