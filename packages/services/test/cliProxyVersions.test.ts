import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cliProxyAssetName,
  ensureKeyFile,
  readKeyFileIfExists,
  readVersionsState,
  releaseDirId,
  resolveCliProxyLayout,
  uninstallCliProxyVersion,
  writeVersionsState,
} from "../src/cli-proxy/cliProxyVersions.js";
import { getNewestVersion, isNewerVersion, parseChecksumsFile } from "../src/cli-proxy/cliProxyReleases.js";

// 运行时本体（docs/specs/plugin-cli-proxy-binary.md）：
// 版本目录/指针切换/卸载回落/令牌落盘/资产命名/checksums 解析/版本比较。

test("资产名按上游命名规则生成（aarch64/amd64，win走zip）", () => {
  assert.equal(
    cliProxyAssetName("8.0.27", "darwin-arm64"),
    "CLIProxyAPI_8.0.27_darwin_aarch64.tar.gz",
  );
  assert.equal(
    cliProxyAssetName("v8.0.27", "linux-x64"),
    "CLIProxyAPI_8.0.27_linux_amd64.tar.gz",
  );
  assert.equal(
    cliProxyAssetName("8.0.27", "win32-x64"),
    "CLIProxyAPI_8.0.27_windows_amd64.zip",
  );
});

test("版本目录id与server-cli releaseId同构", () => {
  const sha = "d9bf58db6e07d0f587a248abc4a1099178fbec1d659d874c961d8caf3495a09e";
  assert.equal(releaseDirId("8.0.27", "darwin-arm64", sha), "8.0.27-darwin-arm64-d9bf58db6e07");
});

test("checksums.txt解析为文件名→sha256", () => {
  const entries = parseChecksumsFile(
    "d9bf58db6e07d0f587a248abc4a1099178fbec1d659d874c961d8caf3495a09e  CLIProxyAPI_8.0.27_darwin_aarch64.tar.gz\ninvalid-line\n",
  );
  assert.equal(entries.get("CLIProxyAPI_8.0.27_darwin_aarch64.tar.gz"), "d9bf58db6e07d0f587a248abc4a1099178fbec1d659d874c961d8caf3495a09e");
  assert.equal(entries.size, 1);
});

test("版本号比较（v前缀归一）", () => {
  assert.equal(isNewerVersion("8.0.27", "8.0.26"), true);
  assert.equal(isNewerVersion("8.0.27", "8.0.27"), false);
  assert.equal(isNewerVersion("v8.0.27", "8.0.26"), true);
  assert.equal(isNewerVersion("8.0.1", null), true);
});

test("getNewestVersion按数字排序处理多位段边界", () => {
  assert.equal(getNewestVersion(["8.0.9", "8.0.10", "8.0.100"]), "8.0.100");
  assert.equal(getNewestVersion(["8.0.100", "v8.0.9", "8.0.10"]), "8.0.100");
  assert.equal(getNewestVersion([]), null);
});

test("版本清单读写往返", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-proxy-versions-"));
  try {
    const layout = resolveCliProxyLayout(join(root, "cli-proxy"));
    assert.deepEqual(await readVersionsState(layout), { activeVersionId: null, versions: [] });
    await writeVersionsState(layout, {
      activeVersionId: "8.0.27-darwin-arm64-abc",
      versions: [
        {
          id: "8.0.27-darwin-arm64-abc",
          version: "8.0.27",
          target: "darwin-arm64",
          archiveSha256: "a".repeat(64),
          dir: join(root, "releases", "8.0.27-darwin-arm64-abc"),
          source: "downloaded",
          downloadedAt: new Date().toISOString(),
        },
      ],
    });
    const state = await readVersionsState(layout);
    assert.equal(state.activeVersionId, "8.0.27-darwin-arm64-abc");
    assert.equal(state.versions.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("卸载非active用户版本不回落", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-proxy-uninstall-"));
  try {
    const layout = resolveCliProxyLayout(join(root, "cli-proxy"));
    const dirA = join(root, "releases", "a");
    const dirB = join(root, "releases", "b");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeVersionsState(layout, {
      activeVersionId: "a",
      versions: [
        { id: "a", version: "1", target: "darwin-arm64", archiveSha256: "a".repeat(64), dir: dirA, source: "downloaded", downloadedAt: "2026-01-01T00:00:00.000Z" },
        { id: "b", version: "2", target: "darwin-arm64", archiveSha256: "b".repeat(64), dir: dirB, source: "downloaded", downloadedAt: "2026-01-02T00:00:00.000Z" },
      ],
    });
    const result = await uninstallCliProxyVersion(layout, "b");
    assert.equal(result.fellBack, false);
    assert.equal(result.activeVersionId, "a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("卸载active回落到最近版本；内置不可卸载", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-proxy-fallback-"));
  try {
    const layout = resolveCliProxyLayout(join(root, "cli-proxy"));
    const dirA = join(root, "releases", "a");
    const dirBundled = join(root, "bundled", "x");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirBundled, { recursive: true });
    await writeVersionsState(layout, {
      activeVersionId: "b",
      versions: [
        { id: "a", version: "1", target: "darwin-arm64", archiveSha256: "a".repeat(64), dir: dirA, source: "downloaded", downloadedAt: "2026-01-01T00:00:00.000Z" },
        { id: "b", version: "2", target: "darwin-arm64", archiveSha256: "b".repeat(64), dir: join(root, "releases", "b"), source: "downloaded", downloadedAt: "2026-01-02T00:00:00.000Z" },
        { id: "bundled-x", version: "bundled", target: "darwin-arm64", archiveSha256: "0".repeat(64), dir: dirBundled, source: "bundled", downloadedAt: new Date(0).toISOString() },
      ],
    });
    await mkdir(join(root, "releases", "b"), { recursive: true });
    const result = await uninstallCliProxyVersion(layout, "b");
    assert.equal(result.fellBack, true);
    assert.equal(result.activeVersionId, "a");
    await assert.rejects(() => uninstallCliProxyVersion(layout, "bundled-x"), /不可卸载/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("令牌文件0600独立落盘、已存在不覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-proxy-key-"));
  try {
    const path = join(root, "management.key");
    assert.equal(await readKeyFileIfExists(path), undefined);
    const first = await ensureKeyFile(path);
    assert.ok(first.length > 0);
    const second = await ensureKeyFile(path);
    assert.equal(second, first);
    const { stat } = await import("node:fs/promises");
    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, 0o600);
    await writeFile(path, "custom\n");
    assert.equal(await ensureKeyFile(path), "custom");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("真实安装：本地tar包走sha256→解压→登记，首装即active", async () => {
  // 真实 downloadAndInstallRelease 语义覆盖（本地文件构造 tar 包 + 真实 checksum）：
  // 首装（无 active）安装后必须直接成为 active，否则自动下载永远用不上。
  const { createHash } = await import("node:crypto");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { readFile } = await import("node:fs/promises");
  const { installCliProxyArchive } = await import("../src/cli-proxy/cliProxyVersions.js");
  const runExec = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), "cli-proxy-realinstall-"));
  try {
    const layout = resolveCliProxyLayout(join(root, "cli-proxy"));
    const stage = join(root, "stage");
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, "cli-proxy-api"), "#!/bin/sh\necho hi\n");
    const archive = join(root, "fake.tar.gz");
    await runExec("tar", ["-czf", archive, "-C", stage, "cli-proxy-api"]);
    const sha = createHash("sha256").update(await readFile(archive)).digest("hex");
    const entry = await installCliProxyArchive({
      layout,
      archivePath: archive,
      version: "9.9.9",
      target: "test-target",
      archiveSha256: sha,
    });
    const state = await readVersionsState(layout);
    assert.equal(state.activeVersionId, entry.id);
    assert.equal(state.versions.length, 1);
    // 第二次安装同版本不同内容：checksum 不符必须拒绝。
    await assert.rejects(
      () =>
        installCliProxyArchive({
          layout,
          archivePath: archive,
          version: "9.9.9",
          target: "test-target",
          archiveSha256: "f".repeat(64),
        }),
      /checksum mismatch/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
