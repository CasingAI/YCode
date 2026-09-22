import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import {
  OversizedInlineFileAttachmentError,
  serializeChatComposerAttachment,
  type ChatComposerAttachment,
} from "../src/lib/chatAttachments.js";
import { uploadComposerAttachment } from "../src/v4/composer/attachmentUpload.js";

// Web 端（无 localPath）附件内容通道：二进制文件必须产出 dataBase64 进入上传事务，
// 文本类走 textContent；超限抛结构化错误。桌面 localPath 路径引用行为保持不变
// （见 docs/specs/web-composer-attachments.md）。

// readAttachmentBase64 依赖浏览器 FileReader；node:test 环境用最小 shim 顶替。
class FileReaderShim {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: string | ArrayBuffer | null = null;
  readAsDataURL(file: File): void {
    void file
      .arrayBuffer()
      .then((buffer) => {
        this.result = `data:${file.type || "application/octet-stream"};base64,${Buffer.from(
          buffer,
        ).toString("base64")}`;
        this.onload?.();
      })
      .catch(() => this.onerror?.());
  }
}
(globalThis as { FileReader?: unknown }).FileReader = FileReaderShim;

function composerAttachment(overrides: Partial<ChatComposerAttachment>): ChatComposerAttachment {
  return {
    id: "test-attachment",
    filename: "probe.bin",
    mimeType: "application/octet-stream",
    sizeBytes: 0,
    ...overrides,
  };
}

test("Web 无 localPath 的二进制文件序列化产出 dataBase64", async () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x42]);
  const attachment = composerAttachment({
    file: new File([bytes], "probe.zip", { type: "application/zip" }),
    filename: "probe.zip",
    mimeType: "application/zip",
    sizeBytes: bytes.byteLength,
  });
  const serialized = await serializeChatComposerAttachment(attachment);
  assert.equal(serialized.kind, "file");
  assert.equal(serialized.localPath, undefined);
  assert.equal("textContent" in serialized, false);
  assert.equal("dataBase64" in serialized, true);
  if (!("dataBase64" in serialized) || typeof serialized.dataBase64 !== "string") {
    throw new Error("dataBase64 missing");
  }
  const decoded = Buffer.from(serialized.dataBase64, "base64");
  assert.deepEqual([...decoded], [...bytes]);
});

test("Web 无 localPath 的文本类文件仍走 textContent", async () => {
  const attachment = composerAttachment({
    file: new File(["附件文本内容"], "probe.txt", { type: "text/plain" }),
    filename: "probe.txt",
    mimeType: "text/plain",
    sizeBytes: 18,
  });
  const serialized = await serializeChatComposerAttachment(attachment);
  assert.equal(serialized.kind, "file");
  if (!("textContent" in serialized)) throw new Error("textContent missing");
  assert.equal(serialized.textContent, "附件文本内容");
});

test("Web 无 localPath 的超大二进制文件抛结构化超限错误", async () => {
  const oversizeBytes = PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1;
  const attachment = composerAttachment({
    file: new File([new Uint8Array(oversizeBytes)], "big.bin", {
      type: "application/octet-stream",
    }),
    filename: "big.bin",
    mimeType: "application/octet-stream",
    sizeBytes: oversizeBytes,
  });
  await assert.rejects(
    serializeChatComposerAttachment(attachment),
    (error: unknown) =>
      error instanceof OversizedInlineFileAttachmentError &&
      error.maxSizeBytes === PROTOCOL_V4_LIMITS.attachmentMaxBytes &&
      error.sizeBytes === oversizeBytes &&
      error.filename === "big.bin",
  );
});

test("桌面 localPath 普通文件保持路径引用，不读 base64", async () => {
  const attachment = composerAttachment({
    filename: "local.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sizeBytes: 4096,
    localPath: "/tmp/definitely-not-real/local.xlsx",
  });
  const serialized = await serializeChatComposerAttachment(attachment);
  assert.equal(serialized.kind, "file");
  assert.equal(serialized.localPath, "/tmp/definitely-not-real/local.xlsx");
  assert.equal("dataBase64" in serialized, false);
  assert.equal("textContent" in serialized, false);
});

test("uploadComposerAttachment 对 dataBase64 附件发起 put 并返回引用", async () => {
  const puts: unknown[] = [];
  const ref = await uploadComposerAttachment(
    async (params) => {
      puts.push(params);
      return { ref: "zcode-artifact://sess/tool-result-1" };
    },
    "sess",
    {
      kind: "file",
      filename: "probe.zip",
      mimeType: "application/zip",
      dataBase64: Buffer.from([0x50, 0x4b]).toString("base64"),
      sizeBytes: 2,
    },
  );
  assert.equal(puts.length, 1);
  assert.deepEqual(ref, {
    ref: "zcode-artifact://sess/tool-result-1",
    fileName: "probe.zip",
    mime: "application/zip",
    bytes: 2,
  });
});

test("uploadComposerAttachment 对元信息-only 附件仍返回 null（防御分支）", async () => {
  const ref = await uploadComposerAttachment(
    async () => {
      throw new Error("put 不应被调用");
    },
    "sess",
    { kind: "file", filename: "empty.bin", mimeType: "application/octet-stream", sizeBytes: 0 },
  );
  assert.equal(ref, null);
});
