import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeToolArtifactStore } from "../src/storage/index.js";

const trace = { traceId: "trace", spanId: "span" };

test("new writes use YCode root while each artifact URI reads its owning root", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "artifact-store-"));
  const zcodeRootDir = join(tempRoot, ".zcode", "cli", "artifacts");
  const ycodeRootDir = join(tempRoot, ".ycode", "cli", "artifacts");
  const store = new NodeToolArtifactStore({
    imageCacheRootDir: join(tempRoot, "cache", "images"),
    pdfCacheRootDir: join(tempRoot, "cache", "pdf"),
    rootDir: zcodeRootDir,
    ycodeRootDir,
    videoCacheRootDir: join(tempRoot, "cache", "videos"),
  });

  try {
    const legacy = await store.writeToolResultArtifact({
      content: "legacy content",
      contentType: "text/plain",
      retention: "session",
      sessionId: "session.with spaces%and-ü",
      toolCallId: "legacy-call",
      toolName: "test",
      trace,
      turnId: "turn",
    });
    assert.equal(legacy.uri.startsWith("ycode-artifact://"), true);
    assert.equal(legacy.path.startsWith(ycodeRootDir), true);
    await assert.rejects(readFile(legacy.path.replace(ycodeRootDir, zcodeRootDir)));

    const legacyUri = "zcode-artifact://session/tool-result-legacy";
    await mkdir(join(zcodeRootDir, "session"), { recursive: true });
    await writeFile(join(zcodeRootDir, "session", "call-tool-result-legacy.txt"), "old");
    const legacyRead = await store.readToolResultArtifact({ uri: legacyUri, trace });
    assert.equal(legacyRead.content, "old");

    const newRead = await store.readToolResultArtifact({ uri: legacy.uri, trace });
    assert.equal(newRead.content, "legacy content");
    const binary = await store.writeToolResultBinaryArtifact({
      content: new Uint8Array([0, 1, 2, 255]),
      contentType: "application/octet-stream",
      extension: ".bin",
      retention: "session",
      sessionId: "session",
      toolCallId: "binary-call",
      toolName: "test",
      trace,
    });
    assert.equal(binary.uri.startsWith("ycode-artifact://"), true);
    assert.ok(binary.path?.startsWith(ycodeRootDir));
    assert.deepEqual(
      [...(await store.readToolResultBinaryArtifact({ uri: binary.uri, trace })).bytes],
      [0, 1, 2, 255],
    );
    const stat = await store.statToolResultArtifact({ uri: legacy.uri, trace });
    assert.equal(stat.path, legacy.path);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
