import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveOfficialPluginRoots } from "../src/app/bundled-plugins.js";
import type { Logger, LogContext } from "@zcode/contracts";

interface RecordedWarn {
  context?: LogContext;
  message: string;
}

function createRecordingLogger(): { warns: RecordedWarn[]; logger: Logger } {
  const warns: RecordedWarn[] = [];
  return {
    logger: {
      child: () => {
        throw new Error("child 不应在本次测试中被调用");
      },
      debug() {},
      error() {},
      info() {},
      warn(message: string, context?: LogContext) {
        warns.push({ context, message });
      },
    },
    warns,
  };
}

function withTempRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "zcode-official-seed-source-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("官方源整体缺失时写空授权清单并记录 warn（含候选目录）", () => {
  withTempRoot((storageRoot) => {
    const { logger, warns } = createRecordingLogger();
    // 注入一个空目录作为唯一候选：模拟桌面构建链漏暂存插件资产时，
    // 进程在其入口旁找不到任何 packages/*-plugin 源的场景。
    const emptyCandidate = join(storageRoot, "entrypoint-dir");
    mkdirSync(emptyCandidate, { recursive: true });

    const roots = resolveOfficialPluginRoots({
      logger,
      seedCandidateBaseDirs: [emptyCandidate],
      storageRoot,
    });

    assert.deepEqual(roots, []);
    assert.equal(warns.length, 1, "无源时必须产生一条可诊断 warn");
    assert.match(warns[0].message, /seed source not found/);
    const context = warns[0].context ?? {};
    assert.deepEqual(context.candidateBaseDirs, [emptyCandidate]);
    assert.equal(context.degraded, true);
    assert.equal(context.module, "bootstrap.official_plugin_cache");

    // fail-closed：bundled marketplace 清单保持为空，不退回扫描整个 official cache。
    const partition = JSON.parse(
      readFileSync(
        join(storageRoot, "marketplaces", "zcode-plugins-official", "bundled-marketplace.json"),
        "utf8",
      ),
    ) as { manifest: { plugins: unknown[] } };
    assert.deepEqual(partition.manifest.plugins, []);
  });
});

test("候选目录未注入时回退到进程默认推导，不影响既有调用方", () => {
  withTempRoot((storageRoot) => {
    const { logger, warns } = createRecordingLogger();

    // 仓库内运行时默认候选总能命中真实插件源，因此不应出现无源 warn；
    // 这里只验证调用不抛错、日志通道未被误触。
    resolveOfficialPluginRoots({ logger, storageRoot });

    assert.equal(warns.length, 0);
  });
});
