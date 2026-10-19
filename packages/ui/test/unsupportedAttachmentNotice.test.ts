import assert from "node:assert/strict";
import test from "node:test";
import { resolveUnsupportedAttachmentKinds } from "../src/v4/composer/unsupportedAttachmentNotice.js";

// 发送前的附件能力提示（docs/specs/model-capability-defaults.md）：
// 判定口径必须与运行时媒体投影一致——能力缺省即不支持，只有显式 true 才算支持。

test("模型不支持的附件类型会被提示", () => {
  const kinds = resolveUnsupportedAttachmentKinds({
    attachments: [{ mimeType: "image/png" }, { mimeType: "application/pdf" }],
    modelResolved: true,
    inputFormat: { supportsImage: true, supportsPdf: false, supportsVideo: false },
  });

  assert.deepEqual(kinds, ["pdf"]);
});

test("纯文本与其它文件不受提示影响", () => {
  const kinds = resolveUnsupportedAttachmentKinds({
    attachments: [
      { mimeType: "text/plain" },
      { mimeType: "application/json" },
      { mimeType: "text/markdown" },
    ],
    modelResolved: true,
    inputFormat: { supportsImage: false, supportsPdf: false, supportsVideo: false },
  });

  assert.deepEqual(kinds, []);
});

test("模型还没解析出来时不提示", () => {
  const kinds = resolveUnsupportedAttachmentKinds({
    attachments: [{ mimeType: "image/png" }],
    modelResolved: false,
    inputFormat: null,
  });

  assert.deepEqual(kinds, []);
});

test("有效配置没有输入能力事实时按纯文本处理", () => {
  const kinds = resolveUnsupportedAttachmentKinds({
    attachments: [{ mimeType: "image/png" }],
    modelResolved: true,
    inputFormat: null,
  });

  assert.deepEqual(kinds, ["image"]);
});

test("多种不支持的类型按图片、PDF、视频固定顺序返回", () => {
  const kinds = resolveUnsupportedAttachmentKinds({
    attachments: [
      { mimeType: "video/mp4" },
      { mimeType: "application/pdf; charset=binary" },
      { mimeType: "image/webp" },
    ],
    modelResolved: true,
    inputFormat: { supportsImage: false, supportsPdf: false, supportsVideo: false },
  });

  assert.deepEqual(kinds, ["image", "pdf", "video"]);
});

test("模型支持的类型不进入提示", () => {
  const kinds = resolveUnsupportedAttachmentKinds({
    attachments: [{ mimeType: "image/png" }, { mimeType: "application/pdf" }],
    modelResolved: true,
    inputFormat: { supportsImage: true, supportsPdf: true, supportsVideo: false },
  });

  assert.deepEqual(kinds, []);
});
