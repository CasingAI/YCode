import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeApp } from "../src/app/types.js";
import { mapAttachmentRefsToTurnAttachments } from "../src/zcode-protocol-v4/commands/attachment-refs.js";

// 非媒体 URI ref 的映射契约：writePromptAttachment 按原扩展名寄存原始字节 artifact 后，
// send 映射必须把它解析回物理路径（与桌面 localPath 同构，agent 用工具读取）；
// 旧 data-URL artifact / 无 stat 能力的 app 回退 ≤64KiB 文本解码与元信息兜底。

function appWith(overrides: Partial<ZCodeApp>): ZCodeApp {
  return overrides as unknown as ZCodeApp;
}

test("非媒体字节 artifact 解析回物理路径（与桌面 localPath 同构）", async () => {
  const app = appWith({
    resolvePromptAttachmentPath: async (ref) =>
      ref === "zcode-artifact://sess/tool-result-1" ? "/cache/sess/x.zip" : null,
  });
  const attachments = await mapAttachmentRefsToTurnAttachments(app, [
    { ref: "zcode-artifact://sess/tool-result-1", fileName: "probe.zip", mime: "application/zip", bytes: 4096 },
  ]);
  assert.equal(attachments?.length, 1);
  assert.deepEqual(attachments?.[0], {
    path: "/cache/sess/x.zip",
    type: "file",
    filename: "probe.zip",
    mimeType: "application/zip",
    sizeBytes: 4096,
  });
});

test("路径解析失败回退 ≤64KiB data-URL 文本解码", async () => {
  const dataUrl = `data:text/plain;base64,${Buffer.from("附件文本", "utf8").toString("base64")}`;
  const app = appWith({
    resolvePromptAttachmentPath: async () => null,
    readToolResultArtifact: async () => ({
      uri: "zcode-artifact://sess/tool-result-2",
      content: dataUrl,
      contentType: "text/plain",
      bytes: dataUrl.length,
    }),
  });
  const attachments = await mapAttachmentRefsToTurnAttachments(app, [
    { ref: "zcode-artifact://sess/tool-result-2", fileName: "note.txt", mime: "text/plain", bytes: 12 },
  ]);
  assert.equal(attachments?.length, 1);
  assert.deepEqual(attachments?.[0], {
    content: "附件文本",
    path: "note.txt",
    type: "file",
    filename: "note.txt",
    mimeType: "text/plain",
    sizeBytes: 12,
  });
});

test("无 resolvePromptAttachmentPath 的旧 app 走既有文本回退", async () => {
  const dataUrl = `data:text/plain;base64,${Buffer.from("legacy", "utf8").toString("base64")}`;
  const app = appWith({
    readToolResultArtifact: async () => ({
      uri: "zcode-artifact://sess/tool-result-3",
      content: dataUrl,
      contentType: "text/plain",
      bytes: dataUrl.length,
    }),
  });
  const attachments = await mapAttachmentRefsToTurnAttachments(app, [
    { ref: "zcode-artifact://sess/tool-result-3", fileName: "old.txt", mime: "text/plain", bytes: 6 },
  ]);
  assert.equal(attachments?.[0]?.type, "file");
  if (attachments?.[0]?.type !== "file") return;
  assert.equal("content" in attachments[0] ? attachments[0].content : undefined, "legacy");
});

test("超 64KiB 且无法解析路径时只保留展示元信息", async () => {
  const app = appWith({
    resolvePromptAttachmentPath: async () => null,
    readToolResultArtifact: async () => {
      throw new Error("不应读回超大 artifact");
    },
  });
  const attachments = await mapAttachmentRefsToTurnAttachments(app, [
    { ref: "zcode-artifact://sess/tool-result-4", fileName: "big.bin", mime: "application/octet-stream", bytes: 65 * 1024 },
  ]);
  assert.deepEqual(attachments?.[0], {
    type: "file",
    filename: "big.bin",
    mimeType: "application/octet-stream",
    sizeBytes: 65 * 1024,
  });
});
