import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteTextFile } from "../src/file/atomicWriteTextFile.js";

test("写文本覆盖已有文件，父目录必须已存在", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-atomic-write-"));
  try {
    const path = join(directory, "note.md");
    await atomicWriteTextFile(path, "hello");
    assert.equal(await readFile(path, "utf8"), "hello");
    await atomicWriteTextFile(path, "world");
    assert.equal(await readFile(path, "utf8"), "world");
    await assert.rejects(atomicWriteTextFile(join(directory, "missing", "a.txt"), "x"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
