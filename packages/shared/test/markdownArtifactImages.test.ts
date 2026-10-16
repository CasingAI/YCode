import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeMarkdownArtifactImageSource,
  extractMarkdownArtifactImageRefs,
  isToolArtifactUri,
  rewriteMarkdownArtifactImageSources,
} from "../src/markdown-artifact-images.js";

test("markdown image projection supports legacy and YCode artifact schemes", () => {
  const markdown = [
    "![old](zcode-artifact://session/old-image)",
    "![new](ycode-artifact://session/new-image)",
  ].join("\n");

  const refs = extractMarkdownArtifactImageRefs(markdown);
  assert.deepEqual(refs, [
    "zcode-artifact://session/old-image",
    "ycode-artifact://session/new-image",
  ]);
  assert.equal(isToolArtifactUri(refs[0]!), true);
  assert.equal(isToolArtifactUri(refs[1]!), true);

  const rewritten = rewriteMarkdownArtifactImageSources(markdown);
  assert.match(rewritten, /__zcode_artifact_image__/u);
  const encodedRef = encodeURIComponent(refs[0]!);
  assert.equal(
    decodeMarkdownArtifactImageSource(`/__zcode_artifact_image__/${encodedRef}`),
    refs[0],
  );
});
