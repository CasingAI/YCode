import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import type { WorkspaceFileListLengthParams, WorkspaceFileListOptions } from "../src/file/file.js";
import { createFileService } from "../src/file/fileService.js";

/**
 * 文件索引用途/选项的自动化验收：
 * - 旧用途（文件引用/快速打开）保持硬过滤与 .zcodeignore；
 * - file-browser 收录 .env、编译产物、隐藏条目与 .zcodeignore 自身；
 * - includeIgnored 跳过规则且不创建/改写 .zcodeignore；
 * - 缓存按身份 + 用途 + 忽略模式隔离，显式 refresh 绕过 60s TTL；
 * - 目录符号链接只作为条目、不递归；
 * - 在途旧扫描不覆盖刷新后的新缓存。
 */

const RANGE_CHUNK = 64;

async function withWorkspace<T>(
  run: (rootPath: string, service: ReturnType<typeof createFileService>) => Promise<T>,
): Promise<T> {
  const rootPath = await mkdtemp(join(tmpdir(), "ycode-file-index-options-"));
  try {
    return await run(rootPath, createFileService());
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function write(rootPath: string, relativePath: string, content = ""): Promise<void> {
  const path = join(rootPath, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function fetchEntries(
  service: ReturnType<typeof createFileService>,
  rootPath: string,
  options: WorkspaceFileListOptions & { refresh?: boolean } = {},
): Promise<WorkspaceFileEntry[]> {
  const rangeOptions: WorkspaceFileListOptions = {
    workspaceIdentity: options.workspaceIdentity,
    purpose: options.purpose,
    includeIgnored: options.includeIgnored,
  };
  const lengthParams: WorkspaceFileListLengthParams = { rootPath, ...options };
  const totalLength = await service.listWorkspaceFilesLength(lengthParams);
  let packed = "";
  for (let offset = 0; offset < totalLength; offset += RANGE_CHUNK) {
    packed += await service.listWorkspaceFilesRange({
      rootPath,
      offset,
      length: RANGE_CHUNK,
      ...rangeOptions,
    });
  }
  return unpackWorkspaceFileEntries(packed, rootPath);
}

function keys(entries: WorkspaceFileEntry[]): string[] {
  return entries.map((entry) => `${entry.type}:${entry.relativePath}`).sort();
}

async function createExplorerFixture(rootPath: string): Promise<void> {
  await write(rootPath, ".zcodeignore", "ignored-dir/\n*.log\n");
  await write(rootPath, "src/app.ts");
  await write(rootPath, ".env");
  await write(rootPath, "build/app.exe");
  await write(rootPath, ".github/workflows/ci.yml");
  await write(rootPath, "ignored-dir/secret.txt");
  await write(rootPath, "app.log");
}

test("旧用途保持硬过滤与忽略规则，浏览器用途放宽但不改写 @ 结果", async () => {
  await withWorkspace(async (rootPath, service) => {
    await createExplorerFixture(rootPath);

    const legacy = keys(await fetchEntries(service, rootPath));
    // 旧用途：.env / 编译产物 / .zcodeignore / 忽略目录与 .log 都不出现；
    // 隐藏目录条目不占候选，但其内部普通文件仍可被名称搜索。
    assert.ok(!legacy.includes("file:.env"));
    assert.ok(!legacy.includes("file:build/app.exe"));
    assert.ok(!legacy.includes("file:.zcodeignore"));
    assert.ok(!legacy.includes("file:ignored-dir/secret.txt"));
    assert.ok(!legacy.includes("file:app.log"));
    assert.ok(!legacy.includes("directory:.github"));
    assert.ok(legacy.includes("file:.github/workflows/ci.yml"));
    assert.ok(legacy.includes("directory:build"));
    assert.ok(legacy.includes("file:src/app.ts"));

    const browser = keys(
      await fetchEntries(service, rootPath, {
        workspaceIdentity: rootPath,
        purpose: "file-browser",
      }),
    );
    assert.ok(browser.includes("file:.env"));
    assert.ok(browser.includes("file:build/app.exe"));
    assert.ok(browser.includes("file:.zcodeignore"));
    assert.ok(browser.includes("directory:.github"));
    assert.ok(browser.includes("file:.github/workflows/ci.yml"));
    // 默认仍遵循 .zcodeignore。
    assert.ok(!browser.includes("directory:ignored-dir"));
    assert.ok(!browser.includes("file:ignored-dir/secret.txt"));
    assert.ok(!browser.includes("file:app.log"));

    // @ / 快速打开继续使用旧用途索引，浏览器结果不会污染它。
    const mentionCandidates = await service.searchWorkspaceFiles({
      rootPath,
      workspaceIdentity: rootPath,
      query: "env",
      limit: 20,
    });
    assert.equal(
      mentionCandidates.some((entry) => entry.relativePath === ".env"),
      false,
    );

    // 浏览器结果缓存后再次回到旧用途，仍然看不到 .env 与编译产物。
    const legacyAgain = keys(await fetchEntries(service, rootPath));
    assert.deepEqual(legacyAgain, legacy);
  });
});

test("includeIgnored 跳过忽略规则，且不创建也不改写 .zcodeignore", async () => {
  await withWorkspace(async (rootPath, service) => {
    await createExplorerFixture(rootPath);
    const ignorePath = join(rootPath, ".zcodeignore");
    const before = await fsPromises.readFile(ignorePath, "utf8");

    const all = keys(
      await fetchEntries(service, rootPath, {
        workspaceIdentity: rootPath,
        purpose: "file-browser",
        includeIgnored: true,
      }),
    );
    assert.ok(all.includes("file:.env"));
    assert.ok(all.includes("file:.zcodeignore"));
    assert.ok(all.includes("directory:ignored-dir"));
    assert.ok(all.includes("file:ignored-dir/secret.txt"));
    assert.ok(all.includes("file:app.log"));
    assert.equal(await fsPromises.readFile(ignorePath, "utf8"), before);

    // 同一工作区回到默认浏览器模式：includeIgnored 缓存不能串到默认模式。
    const filtered = keys(
      await fetchEntries(service, rootPath, {
        workspaceIdentity: rootPath,
        purpose: "file-browser",
      }),
    );
    assert.ok(!filtered.includes("file:ignored-dir/secret.txt"));

    // 回到 includeIgnored 仍然完整，证明两种模式缓存互不覆盖。
    const allAgain = keys(
      await fetchEntries(service, rootPath, {
        workspaceIdentity: rootPath,
        purpose: "file-browser",
        includeIgnored: true,
      }),
    );
    assert.deepEqual(allAgain, all);
  });
});

test("includeIgnored 在缺少规则文件时不会自动创建 .zcodeignore", async () => {
  await withWorkspace(async (rootPath, service) => {
    await write(rootPath, "visible.txt");
    const ignorePath = join(rootPath, ".zcodeignore");
    await assert.rejects(stat(ignorePath), (error: unknown) => {
      return (error as { code?: unknown }).code === "ENOENT";
    });

    const entries = keys(
      await fetchEntries(service, rootPath, { purpose: "file-browser", includeIgnored: true }),
    );
    assert.ok(entries.includes("file:visible.txt"));
    await assert.rejects(stat(ignorePath), (error: unknown) => {
      return (error as { code?: unknown }).code === "ENOENT";
    });
  });
});

test("显式 refresh 在 60s TTL 内绕过缓存并看到外部新建文件", async () => {
  await withWorkspace(async (rootPath, service) => {
    await write(rootPath, ".zcodeignore", "");
    await write(rootPath, "one.txt");
    const options = { purpose: "file-browser" as const };

    const first = await fetchEntries(service, rootPath, options);
    assert.ok(first.some((entry) => entry.relativePath === "one.txt"));
    const firstLength = await service.listWorkspaceFilesLength({ rootPath, ...options });

    await write(rootPath, "two.txt");
    // TTL 内未刷新：仍命中旧索引，不会看到 two.txt。
    const cachedLength = await service.listWorkspaceFilesLength({ rootPath, ...options });
    assert.equal(cachedLength, firstLength);

    const refreshed = await fetchEntries(service, rootPath, { ...options, refresh: true });
    assert.ok(refreshed.some((entry) => entry.relativePath === "two.txt"));
    const refreshedLength = await service.listWorkspaceFilesLength({ rootPath, ...options });
    assert.ok(refreshedLength > firstLength);
  });
});

test("缓存按身份、用途与忽略模式隔离", async () => {
  await withWorkspace(async (rootPath, service) => {
    await createExplorerFixture(rootPath);
    const identity = "workspace-identity-under-test";

    const legacy = keys(await fetchEntries(service, rootPath, { workspaceIdentity: identity }));
    const browser = keys(
      await fetchEntries(service, rootPath, {
        workspaceIdentity: identity,
        purpose: "file-browser",
      }),
    );
    const ignored = keys(
      await fetchEntries(service, rootPath, {
        workspaceIdentity: identity,
        purpose: "file-browser",
        includeIgnored: true,
      }),
    );

    assert.ok(!legacy.includes("file:.env"));
    assert.ok(browser.includes("file:.env"));
    assert.ok(!browser.includes("file:ignored-dir/secret.txt"));
    assert.ok(ignored.includes("file:ignored-dir/secret.txt"));
    assert.notDeepEqual(browser, ignored);

    // 三种模式依次复用后仍各自保持结果（没有共享整包索引）。
    assert.deepEqual(
      keys(await fetchEntries(service, rootPath, { workspaceIdentity: identity })),
      legacy,
    );
    assert.deepEqual(
      keys(
        await fetchEntries(service, rootPath, {
          workspaceIdentity: identity,
          purpose: "file-browser",
        }),
      ),
      browser,
    );
  });
});

test("目录符号链接作为条目但不递归，避免重复与循环", async (t) => {
  await withWorkspace(async (rootPath, service) => {
    await write(rootPath, ".zcodeignore", "");
    await write(rootPath, "real/child.txt");
    await write(rootPath, "target.txt");
    const isPermissionError = (error: unknown) => {
      const code = (error as { code?: unknown }).code;
      return code === "EPERM" || code === "EACCES" || code === "ENOTSUP";
    };
    let hasDirectoryLink = false;
    let hasFileLink = false;
    try {
      // Windows 的 junction 通常不需要开发者模式；POSIX 用 dir 类型。
      await symlink(
        join(rootPath, "real"),
        join(rootPath, "link-dir"),
        process.platform === "win32" ? "junction" : "dir",
      );
      hasDirectoryLink = true;
    } catch (error) {
      if (!isPermissionError(error)) throw error;
    }
    try {
      await symlink(join(rootPath, "target.txt"), join(rootPath, "link-file"), "file");
      hasFileLink = true;
    } catch (error) {
      if (!isPermissionError(error)) throw error;
    }
    if (!hasDirectoryLink && !hasFileLink) {
      t.skip("当前环境无法创建符号链接（需要权限）");
      return;
    }

    const entries = await fetchEntries(service, rootPath, { purpose: "file-browser" });
    const entryKeys = keys(entries);
    if (hasDirectoryLink) {
      assert.ok(entryKeys.includes("directory:link-dir"));
      assert.ok(!entryKeys.includes("file:link-dir/child.txt"));
    }
    if (hasFileLink) {
      assert.ok(entryKeys.includes("file:link-file"));
    }
    // 目标目录内容只出现一次，符号链接目录下不重复展开。
    assert.equal(entryKeys.filter((key) => key === "file:real/child.txt").length, 1);
  });
});

test("在途旧扫描不得覆盖显式刷新后的新缓存", { timeout: 30_000 }, async (t) => {
  await withWorkspace(async (rootPath, service) => {
    await write(rootPath, ".zcodeignore", "");
    await write(rootPath, "old.txt");

    const originalReaddir = fsPromises.readdir as (...args: unknown[]) => Promise<unknown>;
    let releaseOldScan!: () => void;
    const oldScanGate = new Promise<void>((resolve) => {
      releaseOldScan = resolve;
    });
    let signalOldSnapshot!: () => void;
    const oldSnapshotReady = new Promise<void>((resolve) => {
      signalOldSnapshot = resolve;
    });
    let isFirstReaddir = true;
    const readdirMock = t.mock.method(fsPromises, "readdir", async (...args: unknown[]) => {
      // 先取到旧扫描的目录快照，再挂起派发，确保它落后于随后创建的新文件。
      const result = await originalReaddir(...args);
      if (isFirstReaddir) {
        isFirstReaddir = false;
        signalOldSnapshot();
        await oldScanGate;
      }
      return result;
    });
    syncBuiltinESMExports();

    try {
      const oldScan = service.listWorkspaceFilesLength({ rootPath });
      await oldSnapshotReady;
      await write(rootPath, "new.txt");
      const refreshed = await fetchEntries(service, rootPath, { refresh: true });
      assert.ok(refreshed.some((entry) => entry.relativePath === "new.txt"));

      releaseOldScan();
      await oldScan;

      // 旧扫描此刻才完成；若它写回缓存，下面不刷新的读取会丢失 new.txt。
      const afterOldScan = await fetchEntries(service, rootPath);
      assert.ok(afterOldScan.some((entry) => entry.relativePath === "new.txt"));
    } finally {
      releaseOldScan();
      readdirMock.mock.restore();
      syncBuiltinESMExports();
    }
  });
});
