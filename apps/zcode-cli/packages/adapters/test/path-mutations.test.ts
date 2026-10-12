import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isFileSystemPortError } from "@zcode/contracts";
import { NodeFileSystemAdapter } from "../src/fs/index.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "zcode-fs-mut-"));
}

function assertCode(error: unknown, code: string): void {
  assert.ok(isFileSystemPortError(error), String(error));
  assert.equal(error.code, code);
}

test("lstat 看到符号链接，stat 跟随", async () => {
  const root = await tempRoot();
  const target = join(root, "file.txt");
  const link = join(root, "link.txt");
  await writeFile(target, "hi");
  const { symlink } = await import("node:fs/promises");
  await symlink(target, link);
  const port = new NodeFileSystemAdapter();
  const listed = await port.lstat({ path: link });
  assert.equal(listed.kind, "symlink");
  const followed = await port.stat({ path: link });
  assert.equal(followed.kind, "file");
});

test("缺文件：lstat / realpath / rename / copy / rmdir 走 not_found", async () => {
  const root = await tempRoot();
  const missing = join(root, "nope");
  const port = new NodeFileSystemAdapter();
  for (const run of [
    () => port.lstat({ path: missing }),
    () => port.realpath({ path: missing }),
    () => port.rename({ fromPath: missing, toPath: join(root, "b") }),
    () => port.copyFile({ fromPath: missing, toPath: join(root, "b") }),
    () => port.removeDirectory({ path: missing }),
  ]) {
    await assert.rejects(run, (error: unknown) => {
      assertCode(error, "not_found");
      return true;
    });
  }
});

test("removeDirectory：文件是 not_directory，非空是 directory_not_empty", async () => {
  const root = await tempRoot();
  const file = join(root, "file.txt");
  const dir = join(root, "dir");
  await writeFile(file, "x");
  await mkdir(dir);
  await writeFile(join(dir, "child.txt"), "y");
  const port = new NodeFileSystemAdapter();
  await assert.rejects(() => port.removeDirectory({ path: file }), (error: unknown) => {
    assertCode(error, "not_directory");
    return true;
  });
  await assert.rejects(() => port.removeDirectory({ path: dir }), (error: unknown) => {
    assertCode(error, "directory_not_empty");
    return true;
  });
});

test("writeBinary / append / rename / copy / recursive remove 成功路径", async () => {
  const root = await tempRoot();
  const port = new NodeFileSystemAdapter();
  const src = join(root, "a.bin");
  await port.writeBinaryFile({ path: src, content: new Uint8Array([1, 2, 3]) });
  await port.appendFile({ path: src, content: new Uint8Array([4]) });
  const copied = join(root, "b.bin");
  await port.copyFile({ fromPath: src, toPath: copied });
  const renamed = join(root, "c.bin");
  await port.rename({ fromPath: copied, toPath: renamed });
  const nested = join(root, "nested", "gone");
  await port.createDirectory({ path: nested, recursive: true });
  await port.remove({ path: join(root, "nested"), recursive: true, force: true });
  const st = await port.stat({ path: src });
  assert.equal(st.sizeBytes, 4);
  const renamedStat = await port.stat({ path: renamed });
  assert.equal(renamedStat.sizeBytes, 4);
  await assert.rejects(() => port.stat({ path: join(root, "nested") }), (error: unknown) => {
    assertCode(error, "not_found");
    return true;
  });
});

test("mkdir 非递归：父目录不在则失败", async () => {
  const root = await tempRoot();
  const port = new NodeFileSystemAdapter();
  await assert.rejects(
    () => port.createDirectory({ path: join(root, "missing", "child"), recursive: false }),
    (error: unknown) => {
      assertCode(error, "not_found");
      return true;
    },
  );
});
