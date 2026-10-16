import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeCliVersionSidecar } from "../../../scripts/cli-version-sidecar.mjs";
import { stageAgentBundle } from "../scripts/stage-agent-bundle.mjs";
import { OFFICIAL_PLUGIN_STAGING_LIST } from "../scripts/stage-official-plugins.mjs";
import { HISTORY_READ_LANE_WORKER_BUNDLE_NAME } from "../../../apps/zcode-cli/packages/cli/scripts/history-read-lane-worker-bundle.mjs";
import { SQLITE_READ_LANE_WORKER_BUNDLE_NAME } from "../../../apps/zcode-cli/packages/cli/scripts/sqlite-read-lane-worker-bundle.mjs";

/**
 * 造一个最小的可暂存仓库：CLI bundle + sidecar + OFFICIAL_PLUGIN_STAGING_LIST 里的官方插件包源。
 * 插件的 requiredSeedPaths 从 OFFICIAL_PLUGIN_STAGING_LIST 动态生成，与暂存清单同源——
 * 清单加文件时 fixture 自动跟上；反过来，暂存断言漏拷时这里造的文件才成立。
 */
function createStageableRepo(prefix) {
  const repoRoot = mkdtempSync(join(tmpdir(), prefix));
  const distDirectory = join(repoRoot, "apps/zcode-cli/packages/cli/dist");
  mkdirSync(distDirectory, { recursive: true });
  writeFileSync(join(distDirectory, "zcode.cjs"), "module.exports = {};\n", "utf8");
  // 引擎 wasm 与 bundle 同级产出（见 docs/specs/sandbox-system-tool.md「引擎选型」）。
  writeFileSync(join(distDirectory, "quickjs.wasm"), "wasm-bytes\n", "utf8");
  writeFileSync(
    join(distDirectory, HISTORY_READ_LANE_WORKER_BUNDLE_NAME),
    "worker-bytes\n",
    "utf8",
  );
  writeFileSync(
    join(distDirectory, SQLITE_READ_LANE_WORKER_BUNDLE_NAME),
    "sqlite-worker-bytes\n",
    "utf8",
  );
  writeCliVersionSidecar(distDirectory, "0.16.10");

  for (const plugin of OFFICIAL_PLUGIN_STAGING_LIST) {
    const pluginRoot = join(repoRoot, plugin.relativePath);
    mkdirSync(join(pluginRoot, ".zcode-plugin"), { recursive: true });
    writeFileSync(join(pluginRoot, ".zcode-plugin", "plugin.json"), "{}\n", "utf8");
    for (const relativePath of plugin.requiredSeedPaths) {
      const seedPath = join(pluginRoot, ...relativePath.split("/"));
      mkdirSync(join(seedPath, ".."), { recursive: true });
      writeFileSync(seedPath, `seed:${relativePath}\n`, "utf8");
    }
  }
  return repoRoot;
}

test("暂存会拷贝 SQLite 只读查询工作线程到 glm bundle 同级目录", () => {
  const repoRoot = createStageableRepo("zcode-stage-agent-sqlite-worker-");

  stageAgentBundle({ repoRoot, platformKey: "darwin-arm64", log() {} });

  assert.equal(
    readFileSync(
      join(
        repoRoot,
        "packages/desktop/bundled-agents/darwin-arm64/glm",
        SQLITE_READ_LANE_WORKER_BUNDLE_NAME,
      ),
      "utf8",
    ),
    "sqlite-worker-bytes\n",
  );
});

test("缺少 SQLite 只读查询工作线程时暂存失败", () => {
  const repoRoot = createStageableRepo("zcode-stage-agent-missing-sqlite-worker-");
  rmSync(join(repoRoot, "apps/zcode-cli/packages/cli/dist", SQLITE_READ_LANE_WORKER_BUNDLE_NAME));

  assert.throws(
    () => stageAgentBundle({ repoRoot, platformKey: "darwin-arm64", log() {} }),
    /SQLite 只读查询工作线程缺失/,
  );
});

test("暂存会拷贝 sidecar 并把 cliVersion 写入 meta", () => {
  const repoRoot = createStageableRepo("zcode-stage-agent-");

  const result = stageAgentBundle({
    repoRoot,
    platformKey: "darwin-arm64",
    log() {},
  });

  assert.equal(result.cliVersion, "0.16.10");
  assert.match(readFileSync(result.stagedBundlePath, "utf8"), /module\.exports/);
  assert.equal(
    JSON.parse(readFileSync(result.stagedVersionSidecarPath, "utf8")).version,
    "0.16.10",
  );
  assert.equal(JSON.parse(readFileSync(result.stagedMetaPath, "utf8")).cliVersion, "0.16.10");
});

test("暂存把 History 只读旁路工作线程拷进 glm（与 bundle 同级）", () => {
  const repoRoot = createStageableRepo("zcode-stage-agent-history-worker-");

  stageAgentBundle({ repoRoot, platformKey: "darwin-arm64", log() {} });

  assert.equal(
    readFileSync(
      join(
        repoRoot,
        "packages/desktop/bundled-agents/darwin-arm64/glm",
        HISTORY_READ_LANE_WORKER_BUNDLE_NAME,
      ),
      "utf8",
    ),
    "worker-bytes\n",
  );
});

test("缺少 History 只读旁路工作线程时暂存失败", () => {
  const repoRoot = createStageableRepo("zcode-stage-agent-missing-history-worker-");
  rmSync(join(repoRoot, "apps/zcode-cli/packages/cli/dist", HISTORY_READ_LANE_WORKER_BUNDLE_NAME));

  assert.throws(
    () => stageAgentBundle({ repoRoot, platformKey: "darwin-arm64", log() {} }),
    /History 只读旁路工作线程缺失/,
  );
});

test("暂存把引擎 wasm 拷进 glm（与 bundle 同级）", () => {
  const repoRoot = createStageableRepo("zcode-stage-agent-wasm-");

  const result = stageAgentBundle({ repoRoot, platformKey: "darwin-arm64", log() {} });

  assert.equal(
    readFileSync(
      join(repoRoot, "packages/desktop/bundled-agents/darwin-arm64/glm/quickjs.wasm"),
      "utf8",
    ),
    "wasm-bytes\n",
  );
  assert.match(readFileSync(result.stagedBundlePath, "utf8"), /module\.exports/);
});

test("暂存把官方插件资产连同 requiredSeedPaths 写回 glm/packages", () => {
  const repoRoot = createStageableRepo("zcode-stage-agent-plugins-");

  stageAgentBundle({ repoRoot, platformKey: "darwin-arm64", log() {} });

  for (const plugin of OFFICIAL_PLUGIN_STAGING_LIST) {
    const stagedRoot = join(
      repoRoot,
      "packages/desktop/bundled-agents/darwin-arm64/glm",
      plugin.stagedPath,
    );
    assert.equal(
      existsSync(join(stagedRoot, ".zcode-plugin", "plugin.json")),
      true,
      `${plugin.stagedPath} manifest 应已暂存`,
    );
    for (const relativePath of plugin.requiredSeedPaths) {
      assert.equal(
        existsSync(join(stagedRoot, ...relativePath.split("/"))),
        true,
        `${plugin.stagedPath} 缺少 seed 资产 ${relativePath}`,
      );
    }
  }
});

test("清空重建后官方插件资产仍然在位", () => {
  const repoRoot = createStageableRepo("zcode-stage-agent-restage-");

  stageAgentBundle({ repoRoot, platformKey: "darwin-arm64", log() {} });
  // 二次暂存会 rmSync 整个 glm；谁清空谁写回，插件不能在这一步丢掉。
  writeFileSync(
    join(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs"),
    "module.exports = { v: 2 };\n",
    "utf8",
  );
  stageAgentBundle({ repoRoot, platformKey: "darwin-arm64", log() {} });

  for (const plugin of OFFICIAL_PLUGIN_STAGING_LIST) {
    const stagedRoot = join(
      repoRoot,
      "packages/desktop/bundled-agents/darwin-arm64/glm",
      plugin.stagedPath,
    );
    for (const relativePath of plugin.requiredSeedPaths) {
      assert.equal(
        existsSync(join(stagedRoot, ...relativePath.split("/"))),
        true,
        `重建后 ${plugin.stagedPath} 缺少 ${relativePath}`,
      );
    }
  }
});

test("插件源缺少 requiredSeedPaths 文件时暂存失败，不落下残缺布局", () => {
  const repoRoot = createStageableRepo("zcode-stage-agent-incomplete-");
  const broken = OFFICIAL_PLUGIN_STAGING_LIST[0];
  rmSync(join(repoRoot, broken.relativePath, ...broken.requiredSeedPaths[0].split("/")));

  assert.throws(
    () => stageAgentBundle({ repoRoot, platformKey: "darwin-arm64", log() {} }),
    /missing staged official plugin seed asset/,
  );
});

test("缺少 sidecar 时暂存失败，不落下无版本产物", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "zcode-stage-agent-missing-"));
  const distDirectory = join(repoRoot, "apps/zcode-cli/packages/cli/dist");
  mkdirSync(distDirectory, { recursive: true });
  writeFileSync(join(distDirectory, "zcode.cjs"), "module.exports = {};\n", "utf8");

  assert.throws(
    () =>
      stageAgentBundle({
        repoRoot,
        platformKey: "darwin-arm64",
        log() {},
      }),
    /sidecar/,
  );
});
