#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchDesktopElectron } from "../packages/desktop/scripts/launchDesktopElectron.mjs";
import { resolveAgentBundlePaths } from "../packages/desktop/scripts/stage-agent-bundle.mjs";
import { resolvePlatformKeyForPackagedApp } from "../packages/desktop/scripts/target-platform.mjs";
import { withPinnedNodePath } from "./mise-toolchain-env.mjs";
import { runCommand } from "./spawn-command.mjs";

/**
 * 用生产构建产物启动未打包的桌面应用（不调用 electron-builder，不签名）。
 *
 * 语义见 docs/specs/desktop-prebuilt-start.md：
 *   - 构建判定只看产物是否存在，缺才构建，已构建绝不自动重建；
 *   - 构建戳只用于"源码比产物新"的告警，不参与判定；
 *   - 构建范围固定为 本地运行时资源 + 客户端 Agent CLI + 桌面生产构建（含 renderer 与 mobile web）。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = resolve(repoRoot, "packages", "desktop");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const logPrefix = "[prebuilt]";
const stampPath = resolve(desktopRoot, "out", ".prebuilt-start-stamp.json");
const stampFormat = 1;
const zcodeEnvForBuild = "test";
// 陈旧告警最多列出几条具体文件，避免一次改动整目录时刷屏。
const staleSourceLimit = 3;

function log(message) {
  console.log(`${logPrefix} ${message}`);
}

function printHelp() {
  console.log(`预编译启动（不打包、不签名）

用法:
  pnpm start:desktop:prebuilt            已构建则直接启动；缺产物时先构建一次
  pnpm start:desktop:prebuilt --build    强制重建后再启动
  pnpm build:desktop:prebuilt            只构建，不启动（代码改动后的手动重建入口）

mise 等价入口（mise 的 run 任务不接受额外参数，所以重建单独成一条任务）:
  mise run start                         等价于 pnpm start:desktop:prebuilt
  mise run start-build                   等价于 pnpm build:desktop:prebuilt
  ZCODE_PREBUILT_FORCE_BUILD=1 mise run start   等价于 --build

参数:
  -b, --build, --rebuild   跳过产物检查，强制重建
      --build-only         构建完成后不启动 Electron
      --check              只报告判定结果（是否构建、缺哪些产物、是否有更新的源码），不做任何改动
  -h, --help               查看帮助

环境变量:
  ZCODE_PREBUILT_FORCE_BUILD=1   等价于 --build
  ZCODE_DATA_BASE_DIR            数据目录；未设置时与已安装的正式版共享（会告警）
  ZCODE_ENV                      构建期后端环境，默认 test
`);
}

function parseArgs(argv) {
  const options = { forceBuild: false, buildOnly: false, checkOnly: false, help: false };
  for (const arg of argv) {
    if (arg === "--build" || arg === "-b" || arg === "--rebuild") {
      options.forceBuild = true;
      continue;
    }
    if (arg === "--build-only") {
      options.buildOnly = true;
      continue;
    }
    if (arg === "--check") {
      options.checkOnly = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`不支持的参数: ${arg}（用 --help 查看可用参数）`);
  }
  if (isTruthyEnvFlag(process.env.ZCODE_PREBUILT_FORCE_BUILD)) {
    options.forceBuild = true;
  }
  return options;
}

function isTruthyEnvFlag(value) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * 产物清单是"是否需要构建"的唯一真值来源。
 *
 * bundled-agents 的路径不手写：判定与暂存共用 stage-agent-bundle 的解析结果，
 * 否则两处漂移时会出现"判定说没构建、实际产物存在"或反向的静默错配。
 */
const requiredArtifacts = [
  { label: "desktop main bundle", path: resolve(desktopRoot, "out/main/index.js") },
  { label: "desktop host bundle", path: resolve(desktopRoot, "out/host/index.js") },
  { label: "desktop scheduler bundle", path: resolve(desktopRoot, "out/scheduler/index.js") },
  { label: "desktop preload bundle", path: resolve(desktopRoot, "out/preload/index.cjs") },
  { label: "desktop renderer", path: resolve(desktopRoot, "out/renderer/index.html") },
  { label: "mobile web bundle", path: resolve(repoRoot, "packages/web/dist/index.html") },
  {
    label: "agent CLI bundle (bundled-agents)",
    path: resolveAgentBundlePaths({
      repoRoot,
      platformKey: resolvePlatformKeyForPackagedApp(),
    }).stagedBundlePath,
  },
];

/**
 * 构建步骤固定为三件套，全部复用既有脚本，不在这里重复它们的内部逻辑。
 * pre-dev 刻意不参与：它的 `rm -rf out` 只服务 dev，prebuilt 调用它等于每次启动都清空产物。
 */
function createBuildSteps() {
  return [
    {
      label: "本机运行时资源（embedded search / macOS helper）",
      command: process.execPath,
      args: [resolve(desktopRoot, "scripts", "ensure-local-runtime-assets.mjs")],
      cwd: desktopRoot,
    },
    {
      label: "客户端 Agent CLI + MCP plugin runtime",
      command: process.execPath,
      args: [resolve(repoRoot, "scripts", "build-desktop-agent-cli.mjs")],
      cwd: repoRoot,
    },
    {
      label: "桌面生产构建（main/host/preload + renderer + mobile web）",
      command: pnpmCommand,
      args: ["--filter", "@zcode/desktop", "build:no-runtime-assets"],
      cwd: repoRoot,
    },
  ];
}

function createPrebuiltEnv() {
  // 构建与启动共用同一份环境：把启动器的 Node 目录置首，避免另一套 Node 出现在子 shell PATH
  // 前面时 pnpm 用错 runtime 起 package script；ZCODE_ENV 未显式指定时固定为 test。
  return {
    ...withPinnedNodePath({ ...process.env }, process.execPath),
    ZCODE_ENV: process.env.ZCODE_ENV?.trim() || zcodeEnvForBuild,
  };
}

function readGitHead() {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function readBuildStamp() {
  try {
    const parsed = JSON.parse(readFileSync(stampPath, "utf8"));
    if (parsed?.format !== stampFormat || typeof parsed?.builtAtMs !== "number") return null;
    return parsed;
  } catch {
    // 戳缺失或损坏只影响新鲜度告警，不影响启动，静默降级。
    return null;
  }
}

function writeBuildStamp() {
  mkdirSync(dirname(stampPath), { recursive: true });
  writeFileSync(
    stampPath,
    `${JSON.stringify(
      {
        format: stampFormat,
        commit: readGitHead(),
        builtAt: new Date().toISOString(),
        builtAtMs: Date.now(),
        zcodeEnv: process.env.ZCODE_ENV?.trim() || zcodeEnvForBuild,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

const staleScanSkipDirs = new Set([
  "node_modules",
  "dist",
  "out",
  ".turbo",
  ".git",
  "coverage",
  "__snapshots__",
]);

function resolveStaleScanRoots() {
  const roots = [
    "packages/desktop/src",
    "packages/ui/src",
    "packages/web/src",
    "packages/shared/src",
    "packages/services/src",
    "packages/server/src",
    "packages/rpc/src",
    "packages/client/src",
    "packages/provider/src",
    "packages/provider-node/src",
  ].map((relativePath) => resolve(repoRoot, relativePath));

  // agent CLI 侧的包目录是动态的，逐个枚举 packages/*/src，避免整棵 apps/zcode-cli
  // 递归时扫到子 workspace 的 node_modules。
  const cliPackagesRoot = resolve(repoRoot, "apps", "zcode-cli", "packages");
  try {
    for (const entry of readdirSync(cliPackagesRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(cliPackagesRoot, entry.name, "src"));
    }
  } catch {
    // 子模块未初始化时没有这些目录，仅跳过该项扫描。
  }

  return roots.filter((root) => existsSync(root));
}

/** 返回比构建时间新的源码文件，用于提示"当前跑的是旧产物"。 */
function findSourcesNewerThan(timestampMs, limit = staleSourceLimit) {
  const found = [];
  const pending = resolveStaleScanRoots();

  while (pending.length > 0 && found.length < limit) {
    const current = pending.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (found.length >= limit) break;
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!staleScanSkipDirs.has(entry.name)) pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        if (statSync(entryPath).mtimeMs > timestampMs) found.push(entryPath);
      } catch {
        // 遍历期间文件被删除/替换时忽略，不影响启动决策。
      }
    }
  }

  return found;
}

function logMissingArtifacts(missing) {
  log(`缺少 ${missing.length} 项构建产物，先构建一次：`);
  for (const artifact of missing) {
    log(`  - ${artifact.label}: ${artifact.path}`);
  }
}

function reportExistingBuild() {
  const stamp = readBuildStamp();
  if (!stamp) {
    log("发现既有构建产物（无构建戳，无法判断源码新鲜度）。");
    log("要强制重建：pnpm build:desktop:prebuilt");
    return;
  }

  const builtAt = new Date(stamp.builtAtMs).toLocaleString();
  log(
    `复用既有构建产物：builtAt=${builtAt} commit=${stamp.commit ?? "<unknown>"} ZCODE_ENV=${
      stamp.zcodeEnv ?? zcodeEnvForBuild
    }`,
  );

  const staleSources = findSourcesNewerThan(stamp.builtAtMs);
  if (staleSources.length === 0) return;

  log("检测到源码比构建产物新，当前运行的仍是旧产物（不会自动重建）：");
  for (const sourcePath of staleSources) {
    log(`  - ${sourcePath}`);
  }
  log("重新构建：pnpm build:desktop:prebuilt（或 mise run start-build）");
}

function runPrebuiltBuild() {
  const buildEnv = createPrebuiltEnv();
  const steps = createBuildSteps();

  for (const [index, step] of steps.entries()) {
    log(`(${index + 1}/${steps.length}) 构建 ${step.label} ...`);
    // 任一步失败直接向上抛：由入口统一报错退出，不写构建戳、不启动 Electron。
    runCommand(step.command, step.args, { cwd: step.cwd, env: buildEnv });
  }

  writeBuildStamp();
  log("构建完成。");
}

function warnAboutDataBaseDir() {
  if (process.env.ZCODE_DATA_BASE_DIR?.trim()) return;
  // 未隔离时未打包 app 会和已安装的正式版共用 ~/.zcode 下的会话与配置，
  // 排查时容易被"另一个实例写入的数据"误导，这里显式提示。
  log("未设置 ZCODE_DATA_BASE_DIR：将使用默认数据目录，可能与已安装的正式版共享数据。");
  log("建议改用 mise run start（默认隔离到 ~/.zcode-dev-home）。");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  warnAboutDataBaseDir();

  const missing = requiredArtifacts.filter((artifact) => !existsSync(artifact.path));
  if (missing.length === 0) {
    reportExistingBuild();
  } else {
    logMissingArtifacts(missing);
  }

  if (options.checkOnly) {
    const shouldBuild = options.forceBuild || missing.length > 0;
    log(`--check：将执行「${shouldBuild ? "构建后启动" : "直接启动"}」，未做任何改动。`);
    return;
  }

  if (options.forceBuild) {
    log(missing.length > 0 ? "强制重建（忽略产物检查）。" : "强制重建全部产物。");
    runPrebuiltBuild();
  } else if (missing.length > 0) {
    runPrebuiltBuild();
  }

  if (options.buildOnly) {
    log("--build-only：不启动 Electron。");
    return;
  }

  // 不传 rendererUrl：让 main 走 loadFile(out/renderer)，而不是 Vite dev server。
  await launchDesktopElectron({
    desktopRoot,
    label: "prebuilt",
    env: createPrebuiltEnv(),
  });
}

try {
  await main();
} catch (error) {
  console.error(`${logPrefix} ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
