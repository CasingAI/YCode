import assert from "node:assert/strict";
import test from "node:test";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import {
  buildRestoredSessionAttachments,
  isPreviewableAttachmentMime,
  prepareSessionAttachmentPreviews,
  readSessionAttachmentPreviewUrl,
  revokeSessionAttachmentPreviews,
  type SessionAttachmentReadFn,
} from "@/v4/composer/sessionAttachmentPreview.js";

function attachmentRef(overrides: Partial<AttachmentRef> = {}): AttachmentRef {
  return {
    ref: "C:/workspace/test.png",
    fileName: "test.png",
    mime: "image/png",
    bytes: 1024,
    ...overrides,
  };
}

test("可预览判据与 CLI 授权判据一致：只认 image/video/pdf", () => {
  assert.equal(isPreviewableAttachmentMime("image/png"), true);
  assert.equal(isPreviewableAttachmentMime("IMAGE/PNG; charset=binary"), true);
  assert.equal(isPreviewableAttachmentMime("video/mp4"), true);
  assert.equal(isPreviewableAttachmentMime("application/pdf"), true);
  assert.equal(isPreviewableAttachmentMime("text/markdown"), false);
  assert.equal(isPreviewableAttachmentMime("application/octet-stream"), false);
});

test("读回字节时生成 blob URL，宿主已授权的 URL 直接沿用", async () => {
  const readAttachment: SessionAttachmentReadFn = async () => ({
    bytes: new Uint8Array([1, 2, 3]),
    mediaType: "image/png",
  });
  const url = await readSessionAttachmentPreviewUrl({
    attachmentRef: attachmentRef(),
    readAttachment,
    sessionId: "session-1",
  });
  assert.ok(url?.startsWith("blob:"), "字节读取应生成 blob URL");

  const authorized: SessionAttachmentReadFn = async () => ({
    url: "zcode-local-media://local/preview?path=C%3A%2Fworkspace%2Ftest.png",
    mediaType: "image/png",
  });
  const localUrl = await readSessionAttachmentPreviewUrl({
    attachmentRef: attachmentRef(),
    readAttachment: authorized,
    sessionId: "session-1",
  });
  assert.equal(localUrl, "zcode-local-media://local/preview?path=C%3A%2Fworkspace%2Ftest.png");
});

test("读取用 previewRef 优先，previewRef 才是 durable 引用", async () => {
  const seen: string[] = [];
  const readAttachment: SessionAttachmentReadFn = async (params) => {
    seen.push(params.ref);
    return { bytes: new Uint8Array([1]), mediaType: "image/png" };
  };
  await readSessionAttachmentPreviewUrl({
    attachmentRef: attachmentRef({ previewRef: "zcode-artifact://session-1/image.png" }),
    readAttachment,
    sessionId: "session-1",
  });
  assert.deepEqual(seen, ["zcode-artifact://session-1/image.png"]);
});

test("读不回预览不影响撤回编辑：非媒体跳过，读取失败不抛", async () => {
  const readAttachment: SessionAttachmentReadFn = async (params) => {
    if (params.ref.endsWith("missing.png"))
      throw new Error("fault.attachment.previewRefNotAuthorized");
    return { bytes: new Uint8Array([1]), mediaType: "image/png" };
  };
  const previews = await prepareSessionAttachmentPreviews({
    attachments: [
      attachmentRef({ ref: "C:/workspace/ok.png" }),
      attachmentRef({ ref: "C:/workspace/missing.png" }),
      attachmentRef({ ref: "C:/workspace/notes.md", mime: "text/markdown" }),
    ],
    readAttachment,
    sessionId: "session-1",
  });
  assert.deepEqual([...previews.keys()], ["C:/workspace/ok.png"]);
});

test("撤回时按 ref 挂上预览 URL；没有预览的附件保持无 objectUrl", () => {
  const previews = new Map([["C:/workspace/test.png", "blob:preview"]]);
  const restored = buildRestoredSessionAttachments({
    attachmentRefs: [
      attachmentRef(),
      attachmentRef({ ref: "C:/workspace/other.png", fileName: "other.png" }),
    ],
    previews,
    createId: (() => {
      let index = 0;
      return () => `id-${++index}`;
    })(),
  });
  assert.equal(restored[0]?.objectUrl, "blob:preview");
  assert.equal(restored[1]?.objectUrl, undefined);
  assert.equal(restored[0]?.filename, "test.png");
  assert.equal(restored[1]?.id, "id-2");
});

test("回收预览 URL 时逐个撤销", () => {
  const revoked: string[] = [];
  const original = URL.revokeObjectURL;
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  try {
    revokeSessionAttachmentPreviews(
      new Map([
        ["a", "blob:a"],
        ["b", "blob:b"],
      ]),
    );
  } finally {
    URL.revokeObjectURL = original;
  }
  assert.deepEqual(revoked, ["blob:a", "blob:b"]);
});
