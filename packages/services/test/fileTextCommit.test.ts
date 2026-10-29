import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import { promises as fsPromises } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FILE_TEXT_COMMIT_CONFLICT_CODE,
  FILE_TEXT_INVALID_PATCH_CODE,
  FILE_TEXT_NOT_FILE_CODE,
} from "@zcode/shared";
import { createFileService } from "../src/file/fileService.js";

type FileService = ReturnType<typeof createFileService>;

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-file-commit-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function versionOf(fileService: FileService, path: string): Promise<string> {
  return (await fileService.readTextFileWindow({ path, offset: 0, length: 4 })).version;
}

function hasCommitError(code: string, reason?: string) {
  return (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, code);
    if (reason !== undefined) {
      assert.equal((error as { details?: { reason?: unknown } }).details?.reason, reason);
    }
    return true;
  };
}

async function tempEntries(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((entry) => entry.endsWith(".tmp"));
}

test("full 提交覆盖已有文件并返回新版本与总字节数", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "full.txt");
    await writeFile(path, "old content", "utf8");
    const fileService = createFileService();
    const expectedVersion = await versionOf(fileService, path);

    const result = await fileService.commitTextFile({
      path,
      expectedVersion,
      write: { kind: "full", text: "new content" },
    });

    assert.equal(result.path, path);
    assert.equal(result.totalBytes, Buffer.byteLength("new content"));
    assert.equal(await readFile(path, "utf8"), "new content");
    assert.equal(result.version, await versionOf(fileService, path));
    assert.notEqual(result.version, expectedVersion);
  });
});

test("expectedVersion 不匹配返回 CONFLICT 且不写盘", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "conflict.txt");
    await writeFile(path, "disk content", "utf8");
    const fileService = createFileService();
    const staleVersion = await versionOf(fileService, path);
    await writeFile(path, "changed by another writer", "utf8");

    await assert.rejects(
      fileService.commitTextFile({
        path,
        expectedVersion: staleVersion,
        write: { kind: "full", text: "my draft" },
      }),
      hasCommitError(FILE_TEXT_COMMIT_CONFLICT_CODE, "target-version-mismatch"),
    );
    assert.equal(await readFile(path, "utf8"), "changed by another writer");
  });
});

test("expectedVersion null 只允许 full 并在目标已存在时冲突", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "create.txt");
    const fileService = createFileService();

    const created = await fileService.commitTextFile({
      path,
      expectedVersion: null,
      write: { kind: "full", text: "created" },
    });
    assert.equal(await readFile(path, "utf8"), "created");
    assert.equal(created.totalBytes, Buffer.byteLength("created"));

    await assert.rejects(
      fileService.commitTextFile({
        path,
        expectedVersion: null,
        write: { kind: "full", text: "again" },
      }),
      hasCommitError(FILE_TEXT_COMMIT_CONFLICT_CODE, "target-exists"),
    );
    assert.equal(await readFile(path, "utf8"), "created");

    await assert.rejects(
      fileService.commitTextFile({
        path,
        expectedVersion: null,
        write: { kind: "patches", patches: [] },
      }),
      hasCommitError(FILE_TEXT_INVALID_PATCH_CODE),
    );
  });
});

test("patches 按原文件坐标替换、插入与 EOF 追加", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "patches.txt");
    const source = Buffer.concat([
      Buffer.from("AB"),
      Buffer.from([0xff]),
      Buffer.from("中"),
      Buffer.from("D"),
    ]);
    await writeFile(path, source);
    const fileService = createFileService();
    const expectedVersion = await versionOf(fileService, path);

    const result = await fileService.commitTextFile({
      path,
      expectedVersion,
      write: {
        kind: "patches",
        patches: [
          // 乱序发送也应按 offset 升序应用。
          { offset: source.length, deleteBytes: 0, text: "!" },
          { offset: 1, deleteBytes: 1, text: "xy" },
          { offset: 2, deleteBytes: 1, text: "Z" },
        ],
      },
    });

    const expected = Buffer.concat([Buffer.from("AxyZ"), Buffer.from("中"), Buffer.from("D!")]);
    assert.deepEqual(await readFile(path), expected);
    assert.equal(result.totalBytes, expected.length);
  });
});

test("未触碰的非法 UTF-8 字节逐字节保留", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "preserve-invalid.bin");
    const source = Buffer.from([0x41, 0xff, 0x42]);
    await writeFile(path, source);
    const fileService = createFileService();
    const expectedVersion = await versionOf(fileService, path);

    await fileService.commitTextFile({
      path,
      expectedVersion,
      write: {
        kind: "patches",
        patches: [
          { offset: 0, deleteBytes: 0, text: "X" },
          { offset: 2, deleteBytes: 1, text: "Y" },
        ],
      },
    });

    assert.deepEqual(await readFile(path), Buffer.from([0x58, 0x41, 0xff, 0x59]));
  });
});

test("补丁边界切入合法 UTF-8 码点时拒绝，非法 continuation 边界允许", async () => {
  await withTempDir(async (directory) => {
    const fileService = createFileService();

    const validPath = join(directory, "valid-boundary.txt");
    await writeFile(validPath, "中", "utf8");
    const validVersion = await versionOf(fileService, validPath);
    for (const patch of [
      { offset: 1, deleteBytes: 0, text: "x" },
      { offset: 0, deleteBytes: 1, text: "x" },
      { offset: 2, deleteBytes: 1, text: "x" },
    ]) {
      await assert.rejects(
        fileService.commitTextFile({
          path: validPath,
          expectedVersion: validVersion,
          write: { kind: "patches", patches: [patch] },
        }),
        hasCommitError(FILE_TEXT_INVALID_PATCH_CODE, "patch-boundary-inside-codepoint"),
        JSON.stringify(patch),
      );
    }

    const invalidPath = join(directory, "invalid-boundary.bin");
    const invalidSource = Buffer.from([0x41, 0x80, 0x80, 0x42]);
    await writeFile(invalidPath, invalidSource);
    const invalidVersion = await versionOf(fileService, invalidPath);
    await fileService.commitTextFile({
      path: invalidPath,
      expectedVersion: invalidVersion,
      write: {
        kind: "patches",
        patches: [{ offset: 1, deleteBytes: 1, text: "Z" }],
      },
    });
    assert.deepEqual(await readFile(invalidPath), Buffer.from([0x41, 0x5a, 0x80, 0x42]));
  });
});

test("lone surrogate 与非法补丁参数返回 INVALID_PATCH", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "invalid-patch.txt");
    await writeFile(path, "abcdef", "utf8");
    const fileService = createFileService();
    const version = await versionOf(fileService, path);

    await assert.rejects(
      fileService.commitTextFile({
        path,
        expectedVersion: version,
        write: { kind: "full", text: "\uD800" },
      }),
      hasCommitError(FILE_TEXT_INVALID_PATCH_CODE, "invalid-text"),
    );
    await assert.rejects(
      fileService.commitTextFile({
        path,
        expectedVersion: version,
        write: {
          kind: "patches",
          patches: [{ offset: 0, deleteBytes: 0, text: "\uDC00" }],
        },
      }),
      hasCommitError(FILE_TEXT_INVALID_PATCH_CODE, "invalid-text"),
    );

    const invalidPatches = [
      [{ offset: -1, deleteBytes: 0, text: "" }],
      [{ offset: 0, deleteBytes: -1, text: "" }],
      [{ offset: 0, deleteBytes: 1.5, text: "" }],
      [{ offset: 6, deleteBytes: 1, text: "" }],
      [
        { offset: 0, deleteBytes: 2, text: "" },
        { offset: 1, deleteBytes: 1, text: "" },
      ],
      [
        { offset: 0, deleteBytes: 0, text: "a" },
        { offset: 0, deleteBytes: 0, text: "b" },
      ],
    ];
    for (const patches of invalidPatches) {
      await assert.rejects(
        fileService.commitTextFile({
          path,
          expectedVersion: version,
          write: { kind: "patches", patches },
        }),
        hasCommitError(FILE_TEXT_INVALID_PATCH_CODE),
        JSON.stringify(patches),
      );
    }
    assert.equal(await readFile(path, "utf8"), "abcdef");
  });
});

test("另存为同时保护源与目标版本", async () => {
  await withTempDir(async (directory) => {
    const sourcePath = join(directory, "source.txt");
    const targetPath = join(directory, "target.txt");
    await writeFile(sourcePath, "Hello world", "utf8");
    const fileService = createFileService();
    const sourceVersion = await versionOf(fileService, sourcePath);

    const created = await fileService.commitTextFile({
      path: targetPath,
      sourcePath,
      expectedVersion: sourceVersion,
      write: { kind: "full", text: "copied" },
    });
    assert.equal(created.path, targetPath);
    assert.equal(await readFile(targetPath, "utf8"), "copied");
    assert.equal(await readFile(sourcePath, "utf8"), "Hello world");

    // 目标已存在且未提供 expectedTargetVersion，按 null 处理。
    await assert.rejects(
      fileService.commitTextFile({
        path: targetPath,
        sourcePath,
        expectedVersion: sourceVersion,
        write: { kind: "full", text: "overwrite" },
      }),
      hasCommitError(FILE_TEXT_COMMIT_CONFLICT_CODE, "target-exists"),
    );

    const targetVersion = await versionOf(fileService, targetPath);
    await fileService.commitTextFile({
      path: targetPath,
      sourcePath,
      expectedVersion: sourceVersion,
      expectedTargetVersion: targetVersion,
      write: {
        kind: "patches",
        patches: [{ offset: 6, deleteBytes: 5, text: "there" }],
      },
    });
    assert.equal(await readFile(targetPath, "utf8"), "Hello there");
    assert.equal(await readFile(sourcePath, "utf8"), "Hello world");

    // 大文件另存为：目标不存在，补丁基于源版本创建新目标。
    const patchTargetPath = join(directory, "patch-target.txt");
    await fileService.commitTextFile({
      path: patchTargetPath,
      sourcePath,
      expectedVersion: sourceVersion,
      write: {
        kind: "patches",
        patches: [{ offset: 0, deleteBytes: 0, text: ">> " }],
      },
    });
    assert.equal(await readFile(patchTargetPath, "utf8"), ">> Hello world");
    assert.equal(await readFile(sourcePath, "utf8"), "Hello world");

    await writeFile(sourcePath, "source changed", "utf8");
    const missingTarget = join(directory, "not-created.txt");
    await assert.rejects(
      fileService.commitTextFile({
        path: missingTarget,
        sourcePath,
        expectedVersion: sourceVersion,
        write: { kind: "full", text: "stale copy" },
      }),
      hasCommitError(FILE_TEXT_COMMIT_CONFLICT_CODE, "source-version-mismatch"),
    );
    await assert.rejects(stat(missingTarget), hasCommitError("ENOENT"));
  });
});

test("sourcePath 与 path canonical 相同时归一为普通保存", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "same.txt");
    await writeFile(path, "same file", "utf8");
    const fileService = createFileService();
    const version = await versionOf(fileService, path);

    await fileService.commitTextFile({
      path,
      sourcePath: path,
      expectedVersion: version,
      expectedTargetVersion: null,
      write: { kind: "full", text: "normalized" },
    });
    assert.equal(await readFile(path, "utf8"), "normalized");
  });
});

test("提交后目标被外部替换时返回冲突，不冒报外部版本", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "result-identity.txt");
    const externalPath = join(directory, "external.txt");
    await writeFile(path, "original", "utf8");
    await writeFile(externalPath, "external content", "utf8");
    const fileService = createFileService();
    const version = await versionOf(fileService, path);
    const originalStat = fsPromises.stat;
    let substituted = false;
    fsPromises.stat = async (statPath, options) => {
      const result = await originalStat(statPath, options);
      if (
        !substituted &&
        statPath === path &&
        options?.bigint === true &&
        result.isFile() &&
        (await readFile(path, "utf8")) === "committed content"
      ) {
        substituted = true;
        // Windows 不允许替换当前占用的目录项；以外部文件的 stat 结果模拟提交后的路径身份变化。
        return originalStat(externalPath, options);
      }
      return result;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        fileService.commitTextFile({
          path,
          expectedVersion: version,
          write: { kind: "full", text: "committed content" },
        }),
        hasCommitError(FILE_TEXT_COMMIT_CONFLICT_CODE, "target-changed-after-commit"),
      );
      assert.equal(substituted, true);
      assert.equal(await readFile(path, "utf8"), "committed content");
      assert.equal(await readFile(externalPath, "utf8"), "external content");
    } finally {
      fsPromises.stat = originalStat;
      syncBuiltinESMExports();
    }
  });
});

test("提交后同 inode 原地改写（size/mtimeNs 变化）返回冲突，不冒报本次结果", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "result-inode.txt");
    await writeFile(path, "original", "utf8");
    const fileService = createFileService();
    const version = await versionOf(fileService, path);
    const originalStat = fsPromises.stat;
    let substituted = false;
    let identityPreserved = false;
    fsPromises.stat = async (statPath, options) => {
      const result = await originalStat(statPath, options);
      if (
        !substituted &&
        statPath === path &&
        options?.bigint === true &&
        result.isFile() &&
        (await readFile(path, "utf8")) === "committed content"
      ) {
        substituted = true;
        // 保持 dev/ino 不变，只改 size/mtimeNs，模拟同一 inode 被外部原地改写。
        const altered = Object.assign(Object.create(Object.getPrototypeOf(result)), result, {
          size: result.size + 1n,
          mtimeNs: result.mtimeNs + 1n,
        });
        identityPreserved = altered.dev === result.dev && altered.ino === result.ino;
        return altered;
      }
      return result;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        fileService.commitTextFile({
          path,
          expectedVersion: version,
          write: { kind: "full", text: "committed content" },
        }),
        hasCommitError(FILE_TEXT_COMMIT_CONFLICT_CODE, "target-changed-after-commit"),
      );
      assert.equal(substituted, true);
      assert.equal(identityPreserved, true);
      assert.equal(await readFile(path, "utf8"), "committed content");
    } finally {
      fsPromises.stat = originalStat;
      syncBuiltinESMExports();
    }
  });
});

test("不同 service 实例并发提交同一 expectedVersion 只有一个成功", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "concurrent-instances.txt");
    await writeFile(path, "base", "utf8");
    const firstService = createFileService();
    const secondService = createFileService();
    const version = await versionOf(firstService, path);

    const results = await Promise.allSettled([
      firstService.commitTextFile({
        path,
        expectedVersion: version,
        write: { kind: "full", text: "first" },
      }),
      secondService.commitTextFile({
        path,
        expectedVersion: version,
        write: { kind: "full", text: "second" },
      }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.ok(rejected);
    assert.equal((rejected.reason as { code?: unknown }).code, FILE_TEXT_COMMIT_CONFLICT_CODE);
    const content = await readFile(path, "utf8");
    assert.ok(content === "first" || content === "second");
  });
});

test("写临时文件后错误或版本冲突不留下 temp", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "cleanup.txt");
    await writeFile(path, "base", "utf8");
    const fileService = createFileService();
    const version = await versionOf(fileService, path);
    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();

    // 1) temp 已写入后 sync 失败：finally 必须删除本次 temp。
    const originalSync = prototype.sync as typeof probe.sync;
    prototype.sync = async () => {
      throw new Error("injected sync failure");
    };
    try {
      await assert.rejects(
        fileService.commitTextFile({
          path,
          expectedVersion: version,
          write: { kind: "full", text: "not committed" },
        }),
      );
    } finally {
      prototype.sync = originalSync;
    }
    assert.deepEqual(await tempEntries(directory), []);
    assert.equal(await readFile(path, "utf8"), "base");

    // 2) temp 已写入后 precommit 发现源版本变化：冲突时同样删除 temp。
    const originalStat = prototype.stat as typeof probe.stat;
    let bigintStatCalls = 0;
    prototype.stat = async function (this: typeof probe, ...args: Parameters<typeof probe.stat>) {
      const result = await originalStat.apply(this, args);
      if (args[0] !== undefined && (args[0] as { bigint?: boolean }).bigint === true) {
        bigintStatCalls += 1;
        if (bigintStatCalls === 3) {
          return Object.assign(Object.create(Object.getPrototypeOf(result)), result, {
            mtimeNs: result.mtimeNs + 1n,
          });
        }
      }
      return result;
    };
    try {
      await assert.rejects(
        fileService.commitTextFile({
          path,
          expectedVersion: version,
          write: { kind: "patches", patches: [{ offset: 0, deleteBytes: 4, text: "NEW!" }] },
        }),
        hasCommitError(FILE_TEXT_COMMIT_CONFLICT_CODE, "source-changed"),
      );
      assert.ok(bigintStatCalls >= 3);
    } finally {
      prototype.stat = originalStat;
    }
    assert.deepEqual(await tempEntries(directory), []);
    assert.equal(await readFile(path, "utf8"), "base");
  });
});

test("并发提交同一 expectedVersion 只有一个成功，另一个冲突", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "concurrent.txt");
    await writeFile(path, "base", "utf8");
    const fileService = createFileService();
    const version = await versionOf(fileService, path);

    const results = await Promise.allSettled([
      fileService.commitTextFile({
        path,
        expectedVersion: version,
        write: { kind: "full", text: "first" },
      }),
      fileService.commitTextFile({
        path,
        expectedVersion: version,
        write: { kind: "full", text: "second" },
      }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.ok(rejected);
    assert.equal((rejected.reason as { code?: unknown }).code, FILE_TEXT_COMMIT_CONFLICT_CODE);
    const content = await readFile(path, "utf8");
    assert.ok(content === "first" || content === "second");
  });
});

test("通过符号链接提交时保留链接本身并更新真实文件", async () => {
  await withTempDir(async (directory) => {
    const realPath = join(directory, "real.txt");
    const linkPath = join(directory, "link.txt");
    await writeFile(realPath, "old", "utf8");
    try {
      await symlink(realPath, linkPath, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
        return;
      }
      throw error;
    }
    const fileService = createFileService();
    const version = await versionOf(fileService, linkPath);

    const result = await fileService.commitTextFile({
      path: linkPath,
      expectedVersion: version,
      write: { kind: "full", text: "updated through link" },
    });

    assert.equal(result.path, linkPath);
    assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
    assert.equal(await readlink(linkPath), realPath);
    assert.equal(await readFile(realPath, "utf8"), "updated through link");
  });
});

test(
  "提交保留已有目标文件 mode 且不受 POSIX umask 裁剪",
  { skip: process.platform === "win32" },
  async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "mode.txt");
      await writeFile(path, "mode", "utf8");
      await chmod(path, 0o666);
      const fileService = createFileService();
      const version = await versionOf(fileService, path);
      const originalUmask = process.umask(0o077);
      try {
        await fileService.commitTextFile({
          path,
          expectedVersion: version,
          write: { kind: "full", text: "mode updated" },
        });
      } finally {
        process.umask(originalUmask);
      }

      assert.equal((await stat(path)).mode & 0o777, 0o666);
    });
  },
);

test("patch UTF-8 边界探查遇到短读会继续读取并拒绝切开码点", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "short-patch-read.txt");
    await writeFile(path, "aaa中", "utf8");
    const fileService = createFileService();
    const version = await versionOf(fileService, path);
    const handle = await open(path, "r");
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const originalRead = prototype.read as typeof handle.read;
    let readCalls = 0;
    prototype.read = async function (
      this: typeof handle,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null,
    ) {
      readCalls += 1;
      const injectedLength = readCalls === 1 ? Math.min(length, 3) : length;
      return originalRead.call(this, buffer, offset, injectedLength, position);
    };
    try {
      await assert.rejects(
        fileService.commitTextFile({
          path,
          expectedVersion: version,
          write: { kind: "patches", patches: [{ offset: 0, deleteBytes: 4, text: "aaa" }] },
        }),
        hasCommitError(FILE_TEXT_INVALID_PATCH_CODE, "patch-boundary-inside-codepoint"),
      );
      assert.ok(readCalls >= 2);
      assert.deepEqual(await readFile(path), Buffer.from("aaa中", "utf8"));
    } finally {
      prototype.read = originalRead;
    }
  });
});

test("目标为目录或悬空符号链接时返回 NOT_FILE", async () => {
  await withTempDir(async (directory) => {
    const fileService = createFileService();
    await assert.rejects(
      fileService.commitTextFile({
        path: directory,
        expectedVersion: null,
        write: { kind: "full", text: "x" },
      }),
      hasCommitError(FILE_TEXT_NOT_FILE_CODE),
    );

    const danglingPath = join(directory, "dangling.txt");
    try {
      await symlink(join(directory, "missing-target.txt"), danglingPath, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
        return;
      }
      throw error;
    }
    await assert.rejects(
      fileService.commitTextFile({
        path: danglingPath,
        expectedVersion: null,
        write: { kind: "full", text: "x" },
      }),
      hasCommitError(FILE_TEXT_NOT_FILE_CODE),
    );
  });
});
