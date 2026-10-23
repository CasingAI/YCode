import assert from "node:assert/strict";
import test from "node:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createFileService } from "../src/file/fileService.js";

async function workspace(
  run: (root: string, service: ReturnType<typeof createFileService>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "ycode-file-mutation-"));
  try {
    await run(root, createFileService());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("创建排他文件与目录；非法名称和同名失败不覆盖原文件", async () => {
  await workspace(async (rootPath, service) => {
    const result = await service.mutateWorkspaceEntry({
      rootPath,
      mutation: { kind: "create-file", parentPath: rootPath, name: "note.txt" },
    });
    assert.deepEqual(result, { path: join(rootPath, "note.txt"), type: "file", changed: true });
    await writeFile(result.path, "keep");
    await assert.rejects(
      service.mutateWorkspaceEntry({
        rootPath,
        mutation: { kind: "create-file", parentPath: rootPath, name: "note.txt" },
      }),
    );
    assert.equal(await readFile(result.path, "utf8"), "keep");
    await service.mutateWorkspaceEntry({
      rootPath,
      mutation: { kind: "create-directory", parentPath: rootPath, name: "nested" },
    });
    assert.equal((await lstat(join(rootPath, "nested"))).isDirectory(), true);
    for (const name of [
      "",
      " ",
      ".",
      "..",
      "../escape",
      "nested/file",
      "nested\\file",
      "nul\0name",
    ]) {
      await assert.rejects(
        service.mutateWorkspaceEntry({
          rootPath,
          mutation: { kind: "create-file", parentPath: rootPath, name },
        }),
      );
    }
  });
});

test("改名和移动不覆盖目标，同目录移动无操作，根目录和越界受保护", async () => {
  await workspace(async (rootPath, service) => {
    const source = join(rootPath, "source.txt");
    const target = join(rootPath, "target.txt");
    await writeFile(source, "source");
    await writeFile(target, "target");
    await assert.rejects(
      service.mutateWorkspaceEntry({
        rootPath,
        mutation: { kind: "rename", path: source, name: "target.txt" },
      }),
    );
    assert.equal(await readFile(target, "utf8"), "target");
    assert.equal(await readFile(source, "utf8"), "source");
    assert.equal(
      (
        await service.mutateWorkspaceEntry({
          rootPath,
          mutation: { kind: "move", path: source, targetDirectory: rootPath },
        })
      ).changed,
      false,
    );
    const renamed = await service.mutateWorkspaceEntry({
      rootPath,
      mutation: { kind: "rename", path: source, name: "renamed.txt" },
    });
    assert.equal(renamed.previousPath, source);
    await mkdir(join(rootPath, "dest"));
    const moved = await service.mutateWorkspaceEntry({
      rootPath,
      mutation: { kind: "move", path: renamed.path, targetDirectory: join(rootPath, "dest") },
    });
    assert.equal(await readFile(moved.path, "utf8"), "source");
    await assert.rejects(
      service.mutateWorkspaceEntry({ rootPath, mutation: { kind: "delete", path: rootPath } }),
    );
    await assert.rejects(
      service.mutateWorkspaceEntry({
        rootPath,
        mutation: { kind: "create-file", parentPath: join(rootPath, ".."), name: "escape" },
      }),
    );
    await service.mutateWorkspaceEntry({
      rootPath,
      mutation: { kind: "delete", path: moved.path },
    });
    await assert.rejects(lstat(moved.path), { code: "ENOENT" });
  });
});

test("二进制复制和并发副本命名保持原内容，目录不能嵌套进自身", async () => {
  await workspace(async (rootPath, service) => {
    const path = join(rootPath, "image.bin");
    const bytes = Buffer.from([0, 255, 128, 1]);
    await writeFile(path, bytes);
    const copies = await Promise.all(
      [1, 2].map(() =>
        service.mutateWorkspaceEntry({
          rootPath,
          mutation: { kind: "copy", path, targetDirectory: rootPath },
        }),
      ),
    );
    assert.deepEqual(
      copies.map((copy) => copy.path),
      [join(rootPath, "image copy.bin"), join(rootPath, "image copy 2.bin")],
    );
    for (const copy of copies) assert.deepEqual(await readFile(copy.path), bytes);
    const directory = join(rootPath, "folder");
    await mkdir(join(directory, "child"), { recursive: true });
    await writeFile(join(directory, "child", "file.txt"), "nested");
    const copied = await service.mutateWorkspaceEntry({
      rootPath,
      mutation: { kind: "copy", path: directory, targetDirectory: rootPath },
    });
    assert.equal(await readFile(join(copied.path, "child", "file.txt"), "utf8"), "nested");
    for (const kind of ["copy", "move"] as const) {
      await assert.rejects(
        service.mutateWorkspaceEntry({
          rootPath,
          mutation: { kind, path: directory, targetDirectory: join(directory, "child") },
        }),
      );
    }
  });
});

test(
  "符号链接只复制链接本身，禁止通过链接父目录写到工作区外",
  { skip: process.platform === "win32" },
  async () => {
    await workspace(async (rootPath, service) => {
      const outside = await mkdtemp(join(tmpdir(), "ycode-file-outside-"));
      try {
        await symlink(outside, join(rootPath, "external"));
        await assert.rejects(
          service.mutateWorkspaceEntry({
            rootPath,
            mutation: {
              kind: "create-file",
              parentPath: join(rootPath, "external"),
              name: "escape.txt",
            },
          }),
        );
        const result = await service.mutateWorkspaceEntry({
          rootPath,
          mutation: { kind: "copy", path: join(rootPath, "external"), targetDirectory: rootPath },
        });
        assert.equal((await lstat(result.path)).isSymbolicLink(), true);
        assert.equal(await readlink(result.path), outside);
        await service.mutateWorkspaceEntry({
          rootPath,
          mutation: { kind: "delete", path: join(rootPath, "external") },
        });
        assert.deepEqual(await readdir(outside), []);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  },
);

test("变更使搜索缓存失效，拒绝不匹配的运行时变更请求", async () => {
  await workspace(async (rootPath, service) => {
    assert.deepEqual(await service.searchWorkspaceFiles({ rootPath, query: "fresh" }), []);
    await service.mutateWorkspaceEntry({
      rootPath,
      workspaceIdentity: "identity-a",
      mutation: { kind: "create-file", parentPath: rootPath, name: "fresh.txt" },
    });
    assert.equal(
      (await service.searchWorkspaceFiles({ rootPath, query: "fresh" }))[0]?.name,
      "fresh.txt",
    );
    const malformed = { rootPath, mutation: { kind: "delete", path: rootPath, name: "ignored" } };
    await assert.rejects(
      service.mutateWorkspaceEntry(malformed as Parameters<typeof service.mutateWorkspaceEntry>[0]),
    );
  });
});

test("大小写改名保留内容，移动目标重名时两个文件均不变", async () => {
  await workspace(async (rootPath, service) => {
    await writeFile(join(rootPath, "Case.txt"), "source");
    const renamed = await service.mutateWorkspaceEntry({
      rootPath,
      mutation: { kind: "rename", path: join(rootPath, "Case.txt"), name: "case.txt" },
    });
    assert.equal(renamed.changed, true);
    assert.equal(await readFile(renamed.path, "utf8"), "source");
    assert.ok((await readdir(rootPath)).includes("case.txt"));
    const targetDirectory = join(rootPath, "destination");
    await mkdir(targetDirectory);
    await writeFile(join(targetDirectory, "case.txt"), "target");
    await assert.rejects(
      service.mutateWorkspaceEntry({
        rootPath,
        mutation: { kind: "move", path: renamed.path, targetDirectory },
      }),
    );
    assert.equal(await readFile(renamed.path, "utf8"), "source");
    assert.equal(await readFile(join(targetDirectory, "case.txt"), "utf8"), "target");
  });
});

test(
  "递归复制失败只清理本次副本，保留原文件与同名目标",
  { skip: process.platform === "win32" },
  async () => {
    await workspace(async (rootPath, service) => {
      const source = join(rootPath, "source");
      const destination = join(rootPath, "destination");
      await mkdir(source);
      await mkdir(join(destination, "source"), { recursive: true });
      await writeFile(join(source, "a.txt"), "source");
      await writeFile(join(destination, "source", "keep.txt"), "target");
      const server = createServer();
      server.listen(join(source, "socket"));
      await once(server, "listening");
      try {
        await assert.rejects(
          service.mutateWorkspaceEntry({
            rootPath,
            mutation: { kind: "copy", path: source, targetDirectory: destination },
          }),
        );
        assert.equal(await readFile(join(source, "a.txt"), "utf8"), "source");
        assert.equal(await readFile(join(destination, "source", "keep.txt"), "utf8"), "target");
        assert.deepEqual(await readdir(destination), ["source"]);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  },
);

test("递归内部重名结束本次复制，不反复创建副本或阻塞后续变更", async (context) => {
  await workspace(async (rootPath, service) => {
    const source = join(rootPath, "source");
    const targetDirectory = join(rootPath, "destination");
    await mkdir(source);
    await mkdir(targetDirectory);
    const sourceFile = join(source, "collision.txt");
    await writeFile(sourceFile, "keep");
    const originalCopy = fsPromises.copyFile;
    let internalCopies = 0;
    const copyMock = context.mock.method(fsPromises, "copyFile", async (from, to, mode) => {
      if (from === sourceFile) {
        internalCopies += 1;
        // 模拟目标卷不能容纳源目录大小写重名；第二次改报 IO 错，避免旧实现无限重试挂住测试。
        throw Object.assign(new Error("nested copy collision"), {
          code: internalCopies === 1 ? "EEXIST" : "EIO",
        });
      }
      return originalCopy(from, to, mode);
    });
    syncBuiltinESMExports();
    try {
      const results = await Promise.allSettled([
        service.mutateWorkspaceEntry({
          rootPath,
          mutation: { kind: "copy", path: source, targetDirectory },
        }),
        service.mutateWorkspaceEntry({
          rootPath,
          mutation: { kind: "create-file", parentPath: rootPath, name: "after.txt" },
        }),
      ]);
      assert.equal(results[0]?.status, "rejected");
      assert.equal(results[1]?.status, "fulfilled");
      assert.equal(internalCopies, 1);
      assert.deepEqual(await readdir(targetDirectory), []);
      assert.equal(await readFile(sourceFile, "utf8"), "keep");
      assert.equal(await readFile(join(rootPath, "after.txt"), "utf8"), "");
    } finally {
      copyMock.mock.restore();
      syncBuiltinESMExports();
    }
  });
});
