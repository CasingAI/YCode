import assert from "node:assert/strict";
import test from "node:test";
import { resolvedPlaceholderAttachment } from "../src/runtime/helpers/attachment-placeholder.js";

test("PDF placeholder 不把内联 data URL 写入 file part", () => {
  const attachment = {
    type: "pdf",
    content: "data:application/pdf;base64,SECRET",
  } as never;

  const result = resolvedPlaceholderAttachment(attachment, "document.pdf", "invalid");

  assert.equal(result.url, "inline:pdf");
  assert.equal(typeof result.url, "string");
});

test("video placeholder 仅保留合法的 artifact URI", () => {
  const artifactUri = "zcode-artifact://artifact-1";
  const result = resolvedPlaceholderAttachment(
    { type: "video", content: artifactUri } as never,
    "clip.mp4",
    "unavailable",
  );

  assert.equal(result.url, artifactUri);
  assert.equal(typeof result.url, "string");
});
