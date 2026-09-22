import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import type {
  ZCodeAgentAttachmentBeginParams,
  ZCodeAgentAttachmentChunkParams,
  ZCodeAgentAttachmentTerminalParams,
} from "@zcode/services";
import type { V4AttachmentPutParams } from "@zcode/shared/zcode-protocol-v4";
import { computeAttachmentChecksum } from "../src/v4/attachmentChecksum.js";
import { uploadAttachmentTransaction } from "../src/v4/attachmentUploadTransaction.js";

// 复现用户现场：Web 端经 http（局域网/远程）访问属于非安全上下文，crypto.subtle
// 与 randomUUID 都不存在，原实现全部附件在开传前抛 fault.attachment.checksumUnavailable。
// 这里把 globalThis.crypto 换成非安全上下文形态，验证纯 JS SHA-256 回退与事务全流程
// （见 docs/specs/web-composer-attachments.md「非安全上下文的 checksum」）。

function withoutSecureCrypto<T>(run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  // 非安全上下文：没有 subtle 与 randomUUID，getRandomValues 仍可用。
  const insecure = {
    getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
  } as unknown as Crypto;
  // Node 的 globalThis.crypto 是只读 getter，测试内用 defineProperty 换入再还原。
  Object.defineProperty(globalThis, "crypto", {
    value: insecure,
    configurable: true,
    writable: true,
  });
  return run().finally(() => {
    if (original) Object.defineProperty(globalThis, "crypto", original);
    else Reflect.deleteProperty(globalThis, "crypto");
  });
}

async function referenceSha256(bytes: Uint8Array): Promise<string> {
  const digest = await webcrypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return `sha256:${Buffer.from(digest).toString("hex")}`;
}

test("非安全上下文回退哈希与 WebCrypto SHA-256 逐字节一致（边界尺寸对拍）", async () => {
  await withoutSecureCrypto(async () => {
    const sizes = [0, 1, 3, 55, 56, 63, 64, 65, 127, 128, 383, 384, 385, 1000, 70000];
    for (const size of sizes) {
      const bytes = new Uint8Array(size);
      for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + 7) & 0xff;
      assert.equal(
        await computeAttachmentChecksum(bytes),
        await referenceSha256(bytes),
        `size=${size}`,
      );
    }
  });
});

test("安全上下文仍走 WebCrypto 原生路径", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  assert.equal(await computeAttachmentChecksum(bytes), await referenceSha256(bytes));
});

test("非安全上下文上传事务不再抛 checksumUnavailable 并正常 commit", async () => {
  await withoutSecureCrypto(async () => {
    // 900KiB → 3 个 384KiB 分片，覆盖多片上传路径。
    const bytes = new Uint8Array(900 * 1024);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index & 0xff;
    const input: V4AttachmentPutParams = {
      sessionId: "sess_probe",
      fileName: "probe.bin",
      mime: "application/octet-stream",
      dataBase64: Buffer.from(bytes).toString("base64"),
    };

    const beginCalls: ZCodeAgentAttachmentBeginParams[] = [];
    const chunkCalls: ZCodeAgentAttachmentChunkParams[] = [];
    let commitCalls = 0;
    const agent = {
      attachmentBeginV4: async (params: ZCodeAgentAttachmentBeginParams) => {
        beginCalls.push(params);
        return { uploadId: params.uploadId, state: "staging" as const, nextChunkIndex: 0 };
      },
      attachmentChunkV4: async (params: ZCodeAgentAttachmentChunkParams) => {
        chunkCalls.push(params);
        return { uploadId: params.uploadId, nextChunkIndex: params.chunkIndex + 1 };
      },
      attachmentCommitV4: async (_params: ZCodeAgentAttachmentTerminalParams) => {
        commitCalls += 1;
        return { ref: "zcode-artifact://sess_probe/checksum-probe" };
      },
      attachmentAbortV4: async () => {},
    };

    const result = await uploadAttachmentTransaction(
      agent,
      { workspacePath: "/tmp/probe-workspace" },
      input,
    );

    assert.equal(result.ref, "zcode-artifact://sess_probe/checksum-probe");
    assert.equal(beginCalls.length, 1);
    assert.equal(beginCalls[0].totalChunks, 3);
    // begin 携带的 checksum 必须与 Node 原生 SHA-256 一致（CLI 侧按此逐字节比对）。
    assert.equal(beginCalls[0].checksum, await referenceSha256(bytes));
    assert.deepEqual(
      chunkCalls.map((chunk) => chunk.chunkIndex),
      [0, 1, 2],
    );
    assert.equal(commitCalls, 1);
    // uploadId 走 getRandomValues 兜底仍可生成（非安全上下文无 randomUUID）。
    assert.match(beginCalls[0].uploadId, /^upload-/u);
  });
});
