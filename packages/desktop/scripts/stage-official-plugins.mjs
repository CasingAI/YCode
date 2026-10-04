// 官方插件资产的暂存动作：把仓库内的官方插件包按 Agent 侧 filesystem seed 期望的布局
// （bootstrap bundled-plugins.ts 的 candidateBaseDirs + rootCandidates）拷到
// bundled-agents/<platform>/glm/packages/<stagedPath>。
//
// 为什么独立成模块（与 stage-agent-bundle.mjs 同一先例）：
// - prepare-agent-node-bundle.mjs 是「一执行就跑完整流水线」的入口（顶层依次执行
//   buildCliBundle → buildOfficialPluginRuntimes → stageBundle），且打包链会反向调用
//   scripts/build-desktop-agent-cli.mjs；从它导出给共用链 import 等于启动时再跑一遍
//   打包流水线并形成递归。
// - 谁清空 glm，谁就必须把插件一并写回：stageAgentBundle 的 rmSync 整目录重建如果只
//   放回 zcode.cjs，Agent 找不到任何官方插件源，会静默写空 bundled-marketplace.json，
//   表现为官方插件 0 个、Browser Use 的 node_repl 不注册。8792a85 之后桌面只认暂存
//   副本，不再有「源码相对路径恰好命中插件目录」的退路。

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";

export const BROWSER_USE_PLUGIN_PACKAGE_NAME = "@zcode/browser-use-plugin";

// browser-use 只携带自己的 client script 与 skill/docs；node_repl MCP runtime 归
// @zcode/node-repl-host（见 official-plugin-definitions.ts 的宿主注释）。
const browserUseRequiredRuntimePaths = [
  "scripts/browser-client.mjs",
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // documents.json 已暴露 recording lookup，桌面安装包不能复用缺少正文的 runtime。
  "docs/recording.md",
  "docs/workflow.md",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
];

// 打包与 prebuilt/dev 共用链的唯一暂存清单。requiredSeedPaths 必须与
// apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts 的
// OFFICIAL_BROWSER_USE_REQUIRED_SEED_PATHS / OFFICIAL_NODE_REPL_HOST_REQUIRED_SEED_PATHS
// 保持一致：暂存阶段逐项断言这些文件已拷出，缺一个就 fail fast——过去清单里该字段
// 为空，缺文件要到运行时 seed 才降级，暂存拦不住漏拷。
export const OFFICIAL_PLUGIN_STAGING_LIST = [
  {
    packageName: BROWSER_USE_PLUGIN_PACKAGE_NAME,
    relativePath: "apps/zcode-cli/packages/browser-use-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: browserUseRequiredRuntimePaths,
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/browser-use-plugin",
    requiredSeedPaths: [
      "docs/api.json",
      "docs/documents.json",
      "docs/overview.md",
      "docs/recording.md",
      "docs/workflow.md",
      "scripts/browser-client.mjs",
      "skills/control-browser/SKILL.md",
      "skills/web-gui-tester/SKILL.md",
    ],
  },
  {
    // node_repl 宿主：Browser Use 与 Computer Use 共用的 MCP runtime，本轮抽成独立包。
    // 它没有 listing（不进插件市场展示面），但首启 seed 必须拿到它的 dist runtime，
    // 否则 bua/cua 任一开启时都会连不上 node_repl。
    packageName: "@zcode/node-repl-host",
    relativePath: "apps/zcode-cli/packages/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/node-repl-host",
    requiredSeedPaths: ["dist/mcp/server.js"],
  },
];

const includedOfficialPluginTopLevelPaths = new Set([
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // Electron 生产资源复制有独立白名单，遗漏 agents 会让首启 filesystem seed 永久缺少子代理。
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  "scripts",
  "skills",
  "templates",
]);

const excludedOfficialPluginAssetNames = new Set([
  ".DS_Store",
  ".venv",
  "__pycache__",
  "node_modules",
]);

function shouldCopyOfficialPluginAsset(sourcePath) {
  const name = basename(sourcePath);
  return !excludedOfficialPluginAssetNames.has(name) && !name.endsWith(".pyc");
}

/** 暂存前断言插件 runtime 产物存在（构建失败的直接暴露，而不是等运行时 seed 降级）。 */
export function assertOfficialPluginRuntime({ repoRoot, plugin }) {
  const pluginRoot = resolve(repoRoot, plugin.relativePath);
  for (const relativePath of plugin.requiredRuntimePaths) {
    const runtimePath = resolve(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(runtimePath)) {
      throw new Error(`[stage:official-plugins] missing official plugin runtime: ${runtimePath}`);
    }
  }
}

/**
 * 把官方插件包拷到 glm/packages/<stagedPath>，并断言 manifest 与全部 requiredSeedPaths
 * 就位。清空 glm 的动作（stageAgentBundle 的 rmSync）必须紧跟着调用本函数。
 */
export function stageOfficialPlugins({ repoRoot, glmDir, log = () => {} }) {
  for (const plugin of OFFICIAL_PLUGIN_STAGING_LIST) {
    const sourceRoot = resolve(repoRoot, plugin.relativePath);
    const manifestPath = resolve(sourceRoot, ".zcode-plugin", "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`[stage:official-plugins] missing official plugin manifest: ${manifestPath}`);
    }

    const targetRoot = resolve(glmDir, plugin.stagedPath);
    mkdirSync(targetRoot, { recursive: true });
    for (const entryName of includedOfficialPluginTopLevelPaths) {
      const sourcePath = resolve(sourceRoot, entryName);
      if (!existsSync(sourcePath)) continue;
      cpSync(sourcePath, resolve(targetRoot, entryName), {
        recursive: true,
        filter: shouldCopyOfficialPluginAsset,
      });
    }
    for (const relativePath of plugin.requiredSeedPaths) {
      const stagedAssetPath = resolve(targetRoot, ...relativePath.split("/"));
      if (!existsSync(stagedAssetPath)) {
        throw new Error(
          `[stage:official-plugins] missing staged official plugin seed asset: ${stagedAssetPath}`,
        );
      }
    }
    log(`[stage:official-plugins] staged official plugin ${plugin.stagedPath}`);
  }
}
