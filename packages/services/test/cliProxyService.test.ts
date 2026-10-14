import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCliProxyService } from "../src/cli-proxy/cliProxyService.js";

// 运行时服务（docs/specs/plugin-cli-proxy-binary.md）：
// 按需启动判定（无依赖不启动、有依赖启动）、无二进制时如实报 binary-missing。

test("无依赖provider时不启动", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-proxy-refresh-"));
  const service = createCliProxyService({
    hasDependentProviders: () => false,
    dataBaseDir: root,
  });
  try {
    const status = await service.refresh();
    assert.equal(status.needed, false);
    assert.equal(status.state, "stopped");
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("有依赖但无二进制时报binary-missing而非崩溃", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-proxy-missing-"));
  const service = createCliProxyService({
    hasDependentProviders: () => true,
    dataBaseDir: root,
    // 首启下载默认开启会发网络：该用例只断言无二进制时的如实报错，显式关闭。
    bootstrapDownloadOnFirstStart: false,
  });
  try {
    const status = await service.refresh();
    assert.equal(status.needed, true);
    assert.equal(status.state, "error");
    assert.equal(status.errorCode, "binary-missing");
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("假二进制可启动并监听端口", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-proxy-fake-"));
  const service = createCliProxyService({
    hasDependentProviders: () => true,
    dataBaseDir: root,
    bundledDir: join(root, "bundled"),
  });
  try {
    // 假二进制：打印真实就绪行形态（8.0.27 实测：
    // "API server started successfully on: 127.0.0.1:<port>"）后常驻。
    const dir = join(root, "bundled");
    await mkdir(dir, { recursive: true });
    const script = join(dir, "cli-proxy-api");
    await writeFile(
      script,
      `#!/bin/sh\necho "API server started successfully on: 127.0.0.1:${8471}"\nexec sleep 30\n`,
    );
    await chmod(script, 0o755);
    const status = await service.refresh();
    assert.equal(status.state, "running");
    assert.equal(status.port, 8471);
    // 移除依赖后停止。
    const stopped = await (async () => {
      service.dispose();
      const second = createCliProxyService({
        hasDependentProviders: () => false,
        dataBaseDir: root,
        bundledDir: dir,
      });
      try {
        return await second.refresh();
      } finally {
        second.dispose();
      }
    })();
    assert.equal(stopped.state, "stopped");
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, { timeout: 30_000 });

test("生成的config.yaml是v8嵌套结构", async () => {
  // 真二进制 8.0.27 实测：监听在 server 段（server.host/server.port），
  // 顶层 config-version: 8；启动参数只有 --config（无 --port）。
  const root = await mkdtemp(join(tmpdir(), "cli-proxy-config-"));
  const service = createCliProxyService({
    hasDependentProviders: () => true,
    dataBaseDir: root,
    bundledDir: join(root, "bundled"),
  });
  try {
    const dir = join(root, "bundled");
    await mkdir(dir, { recursive: true });
    const script = join(dir, "cli-proxy-api");
    await writeFile(
      script,
      `#!/bin/sh\necho "API server started successfully on: 127.0.0.1:8472"\nexec sleep 30\n`,
    );
    await chmod(script, 0o755);
    const status = await service.refresh();
    assert.equal(status.state, "running");
    const { readFile } = await import("node:fs/promises");
    const { parse } = await import("yaml");
    const config = parse(await readFile(join(root, ".zcode", "cli-proxy", "config.yaml"), "utf8"));
    assert.equal(config["config-version"], 8);
    assert.equal(config.server.host, "127.0.0.1");
    assert.equal(typeof config.server.port, "number");
    assert.equal(typeof config.management["secret-key"], "string");
    assert.equal(config.management["allow-remote"], false);
    assert.equal(config.access["api-keys"].length, 1);
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, { timeout: 30_000 });

test("用法文本里的数字不被误判为就绪端口", async () => {
  // 回归：旧的":数字"宽松匹配会把真二进制 --help 用法文本
  // （如 "(default 3s)" / "OAuth callback port"）里的数字误判为端口（实测误判出 38）。
  // 假二进制：先吐一段含数字的用法文本，再以非零退出，且从不打印真实就绪行。
  const root = await mkdtemp(join(tmpdir(), "cli-proxy-usage-"));
  const service = createCliProxyService({
    hasDependentProviders: () => true,
    dataBaseDir: root,
    bundledDir: join(root, "bundled"),
  });
  try {
    const dir = join(root, "bundled");
    await mkdir(dir, { recursive: true });
    const script = join(dir, "cli-proxy-api");
    await writeFile(
      script,
      `#!/bin/sh\necho "CLIProxyAPI Version: 8.0.27, Commit: bf934162"\necho "  -discover-timeout int"\necho "    Timeout in seconds for LAN discovery (default 3s) (default 3)"\necho "  -oauth-callback-port int"\necho "    Override OAuth callback port (defaults to provider-specific port)"\nexit 2\n`,
    );
    await chmod(script, 0o755);
    const status = await service.refresh();
    assert.equal(status.state, "error");
    assert.equal(status.errorCode, "start-failed");
    assert.equal(status.port, null);
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, { timeout: 30_000 });

test("启动成功后按实际端口回填（让位场景回调拿到真实端口）", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-proxy-portsync-"));
  let synced: Array<{ port: number; dataKey: string }> = [];
  const service = createCliProxyService({
    hasDependentProviders: () => true,
    dataBaseDir: root,
    bundledDir: join(root, "bundled"),
    syncProviderEndpoints: async (input) => {
      synced.push(input);
    },
  });
  try {
    const dir = join(root, "bundled");
    await mkdir(dir, { recursive: true });
    const script = join(dir, "cli-proxy-api");
    await writeFile(
      script,
      `#!/bin/sh\necho "API server started successfully on: 127.0.0.1:${8472}"\nexec sleep 30\n`,
    );
    await chmod(script, 0o755);
    const status = await service.refresh();
    assert.equal(status.state, "running");
    assert.equal(status.port, 8472);
    // 投影回调拿到的就是实际绑定端口（让位后也是这个值，不是落盘的默认端口），
    // 且数据面 api-key 与 config.yaml access.api-keys 里的值同源（同一 data.key）。
    assert.equal(synced.length, 1);
    assert.equal(synced[0].port, 8472);
    assert.equal(typeof synced[0].dataKey, "string");
    assert.ok(synced[0].dataKey.length > 0);
    const { readFile: readFileKey } = await import("node:fs/promises");
    const dataKeyOnDisk = (
      await readFileKey(join(root, ".zcode", "cli-proxy", "data.key"), "utf8")
    ).trim();
    assert.equal(synced[0].dataKey, dataKeyOnDisk);

    // 运行中再次 refresh（provider 变更订阅触发）：必须补一次投影，
    // 否则运行期新增的 provider 永远拿不到 api-key（真机复现 2026-10-14）。
    const before = synced.length;
    await service.refresh();
    assert.equal(synced.length, before + 1);
    assert.equal(synced[synced.length - 1].port, 8472);
    assert.equal(synced[synced.length - 1].dataKey, dataKeyOnDisk);
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, { timeout: 30_000 });

test("error态再次refresh可重试启动（根因回归）", async () => {
  // 根因：首次启动失败进入 error 后，旧 refresh 只在 stopped 时 start，
  // 导致一次 binary-missing 就永久卡死，provider 已存在也永不拉起。
  const root = await mkdtemp(join(tmpdir(), "cli-proxy-retry-"));
  const dir = join(root, "bundled");
  const service = createCliProxyService({
    hasDependentProviders: () => true,
    dataBaseDir: root,
    bundledDir: dir,
    // 同上：该用例测 error 态重试，不依赖网络下载。
    bootstrapDownloadOnFirstStart: false,
  });
  try {
    const first = await service.refresh();
    assert.equal(first.state, "error");
    assert.equal(first.errorCode, "binary-missing");
    // 后补二进制：再次 refresh 必须重试并进入 running。
    await mkdir(dir, { recursive: true });
    const script = join(dir, "cli-proxy-api");
    await writeFile(
      script,
      `#!/bin/sh\necho "API server started successfully on: 127.0.0.1:${8473}"\nexec sleep 30\n`,
    );
    await chmod(script, 0o755);
    const second = await service.refresh();
    assert.equal(second.state, "running");
    assert.equal(second.port, 8473);
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, { timeout: 60_000 });

test("生产默认路径：首启下载→登记active→启动尝试（全链）", async () => {
  // 生产默认（bootstrapDownloadOnFirstStart 开）全链：
  // 无二进制 → refresh → doStart 内更新检查（注入 fake）→ 安装登记为 active → 启动尝试。
  // 注意：本用例的安装是注入 fake（手写落盘），未走真实 downloadAndInstallRelease
  //（下载→sha256→解压）；真实安装语义由 cliProxyVersions.test.ts「真实安装」用例覆盖。
  // 注入的 fake 安装写一个假二进制脚本，启动应进入 running。
  const root = await mkdtemp(join(tmpdir(), "cli-proxy-bootstrap-"));
  let updateCheckCalls = 0;
  const service = createCliProxyService({
    hasDependentProviders: () => true,
    dataBaseDir: root,
    // 不关闭首启下载：走生产默认，但检查与安装都注入 fake，不发网络。
    checkForUpdateReleases: async () => {
      updateCheckCalls += 1;
      return {
        latestVersion: "9.9.9",
        asset: {
          version: "9.9.9",
          target: "test-target",
          archiveUrl: "https://example.invalid/fake.tar.gz",
          archiveSha256: "0".repeat(64),
        },
      };
    },
    installReleaseAsset: async (layout, asset) => {
      const { writeVersionsState, readVersionsState } = await import(
        "../src/cli-proxy/cliProxyVersions.js"
      );
      const dir = join(layout.releasesDir, `fake-${asset.version}`);
      await mkdir(dir, { recursive: true });
      const script = join(dir, "cli-proxy-api");
      await writeFile(
        script,
        `#!/bin/sh\necho "API server started successfully on: 127.0.0.1:${8474}"\nexec sleep 30\n`,
      );
      await chmod(script, 0o755);
      // 首装即 active（与 installCliProxyArchive 同语义）。
      const state = await readVersionsState(layout);
      await writeVersionsState(layout, {
        activeVersionId: state.activeVersionId ?? `fake-${asset.version}`,
        versions: [
          ...state.versions,
          {
            id: `fake-${asset.version}`,
            version: asset.version,
            target: asset.target,
            archiveSha256: asset.archiveSha256,
            dir,
            source: "downloaded",
            downloadedAt: new Date().toISOString(),
          },
        ],
      });
    },
  });
  try {
    const status = await service.refresh();
    // 下载成功后登记并启动尝试：fake 二进制打印就绪行，应进入 running。
    assert.equal(updateCheckCalls, 1);
    assert.equal(status.state, "running");
    assert.equal(status.port, 8474);
    const snapshot = await service.getStatus();
    assert.ok(snapshot.activeVersionId?.includes("9.9.9"));
    assert.ok(snapshot.versions.length >= 1);
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, { timeout: 60_000 });

test("首启断网后恢复网络可自愈（退避重试不断网锁死）", async () => {
  // 死状态回归：首次更新检查失败（断网）不得永久锁死；退避间隔过后下次 refresh 可再试。
  const root = await mkdtemp(join(tmpdir(), "cli-proxy-selfheal-"));
  let calls = 0;
  const service = createCliProxyService({
    hasDependentProviders: () => true,
    dataBaseDir: root,
    bootstrapRetryCooldownMs: 0,
    checkForUpdateReleases: async () => {
      calls += 1;
      // 首启断网：checkCliProxyUpdates 真实语义是失败返回空结果不抛错。
      if (calls === 1) return { latestVersion: null, asset: null };
      return {
        latestVersion: "9.9.9",
        asset: {
          version: "9.9.9",
          target: "test-target",
          archiveUrl: "https://example.invalid/fake.tar.gz",
          archiveSha256: "0".repeat(64),
        },
      };
    },
    installReleaseAsset: async (layout, asset) => {
      const { writeVersionsState, readVersionsState } = await import(
        "../src/cli-proxy/cliProxyVersions.js"
      );
      const dir = join(layout.releasesDir, `fake-${asset.version}`);
      await mkdir(dir, { recursive: true });
      const script = join(dir, "cli-proxy-api");
      await writeFile(
        script,
        `#!/bin/sh\necho "API server started successfully on: 127.0.0.1:${8475}"\nexec sleep 30\n`,
      );
      await chmod(script, 0o755);
      const state = await readVersionsState(layout);
      await writeVersionsState(layout, {
        activeVersionId: state.activeVersionId ?? `fake-${asset.version}`,
        versions: [
          ...state.versions,
          {
            id: `fake-${asset.version}`,
            version: asset.version,
            target: asset.target,
            archiveSha256: asset.archiveSha256,
            dir,
            source: "downloaded",
            downloadedAt: new Date().toISOString(),
          },
        ],
      });
    },
  });
  try {
    // 首次：检查失败 → 无二进制 → binary-missing，但不锁死。
    const first = await service.refresh();
    assert.equal(first.state, "error");
    assert.equal(first.errorCode, "binary-missing");
    // 恢复网络后再次 refresh：应重新检查并启动成功。
    const second = await service.refresh();
    assert.equal(calls, 2);
    assert.equal(second.state, "running");
    assert.equal(second.port, 8475);
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, { timeout: 60_000 });
