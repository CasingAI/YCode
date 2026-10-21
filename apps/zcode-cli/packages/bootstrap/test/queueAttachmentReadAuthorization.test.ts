import assert from "node:assert/strict";
import test from "node:test";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import { findAuthorizedQueueAttachment } from "../src/zcode-protocol-v4/attachment-read-authorization.js";

// 队列项的附件读取授权（docs/specs/conversation-queue-edit-attachment-preview.md）：
// 队列项还没落成 user row，但它是 session 自有事实，能证明 ref 属于本 session。

function attachment(overrides: Partial<AttachmentRef> = {}): AttachmentRef {
  return {
    ref: "C:/workspace/test.png",
    fileName: "test.png",
    mime: "image/png",
    bytes: 1024,
    ...overrides,
  };
}

test("队列项里的媒体附件可以被同 ref 授权", () => {
  const found = findAuthorizedQueueAttachment({
    queueItems: [{ attachments: [attachment()] }],
    ref: "C:/workspace/test.png",
  });
  assert.equal(found?.fileName, "test.png");
});

test("队列项之外的 ref 不放行：renderer 自报路径拿不到授权", () => {
  const found = findAuthorizedQueueAttachment({
    queueItems: [{ attachments: [attachment()] }],
    ref: "C:/workspace/other.png",
  });
  assert.equal(found, null);
});

test("非媒体附件不进入可预览授权面", () => {
  const found = findAuthorizedQueueAttachment({
    queueItems: [{ attachments: [attachment({ mime: "text/markdown" })] }],
    ref: "C:/workspace/test.png",
  });
  assert.equal(found, null);
});

test("存在 previewRef 时只认 durable 引用，不重新放行原始路径", () => {
  const found = findAuthorizedQueueAttachment({
    queueItems: [
      {
        attachments: [
          attachment({ previewRef: "zcode-artifact://session-1/image.png" }),
        ],
      },
    ],
    ref: "zcode-artifact://session-1/image.png",
  });
  assert.equal(found?.previewRef, "zcode-artifact://session-1/image.png");
  assert.equal(
    findAuthorizedQueueAttachment({
      queueItems: [
        {
          attachments: [
            attachment({ previewRef: "zcode-artifact://session-1/image.png" }),
          ],
        },
      ],
      ref: "C:/workspace/test.png",
    }),
    null,
  );
});

test("空队列或缺附件的队列项不授权任何 ref", () => {
  assert.equal(findAuthorizedQueueAttachment({ queueItems: [], ref: "C:/workspace/test.png" }), null);
  assert.equal(
    findAuthorizedQueueAttachment({ queueItems: [{}], ref: "C:/workspace/test.png" }),
    null,
  );
});
