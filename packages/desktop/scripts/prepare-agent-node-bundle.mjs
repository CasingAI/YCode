#!/usr/bin/env node

// 桌面打包态的 agent 运行时资产：把 agent 的 JS bundle（zcode.cjs）放进 bundled-agents/<platform>/glm，
// 由 app 内置的 Electron Node runtime（ELECTRON_RUN_AS_NODE）执行，替代以前随包内置的独立 Node 二进制。
//
// 为什么这么做：
// - agent 没有任何原生 NAPI 插件（ripgrep 是 WASM，其余纯 JS），可直接跑在 Electron 的 Node 上；
// - Electron 41 内置 Node 24.x，与 zcode-cli 的目标运行时一致；
// - 单平台体积从 ~180MB 降到 ~16MB，且同一份 JS 跨平台通用；
// - app-server 命令路径不会加载 @zcode/tui，所以这里天然不打包 TUI。
//
// 远端（SSH/WSL/Docker）没有 Electron，仍走 prepare:remote-assets 的原生二进制，互不影响。

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { stageAgentBundle } from "./stage-agent-bundle.mjs";
import {
  BROWSER_USE_PLUGIN_PACKAGE_NAME,
  OFFICIAL_PLUGIN_STAGING_LIST,
  assertOfficialPluginRuntime,
} from "./stage-official-plugins.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const cliBundlePath = resolve(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
const pnpmRunEnv = {
  ...process.env,
  // pnpm 11 会在 apps/zcode-cli 子 workspace 执行 run 前触发 install；
  // 子 workspace 不能解析根 workspace 的 @zcode/shared，Docker/web app 打包会因此卡在插件 runtime 构建。
  PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
  // 安装包准备与预编译启动一样递增 CLI patch，并写出 sidecar 供 Electron 绑定。
  ZCODE_BUMP_CLI_VERSION: "1",
};

// 平台目录命名：darwin/win32/linux + x64/arm64，
// 支持 ZCODE_TARGET_OS / ZCODE_TARGET_ARCH 覆盖（交叉打包时由 CI 注入）。
function normalizePlatform(raw) {
  switch (raw) {
    case "mac":
    case "macos":
    case "darwin":
    case "osx":
      return "darwin";
    case "win":
    case "windows":
    case "win32":
      return "win32";
    case "linux":
      return "linux";
    default:
      return raw;
  }
}

function normalizeArch(raw) {
  switch (raw) {
    case "x86_64":
    case "x64":
    case "amd64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return raw;
  }
}

const platform = normalizePlatform(process.env.ZCODE_TARGET_OS || "") || process.platform;
const arch = normalizeArch(process.env.ZCODE_TARGET_ARCH || "") || process.arch;
const platformKey = `${platform}-${arch}`;

// zcode.cjs / .node-bundle-meta.json 的落点由 stage-agent-bundle.mjs 自己解析（同源）。
// node_repl 宿主抽成独立包 @zcode/node-repl-host 之后，browser-use 不再产出
// dist/mcp/server.js，CUA 资产（docs/computer-use.md、scripts/computer-use-client.mjs）
// 也已归 @zcode/zcode-cua-plugin。这份清单当时漏改，打包准备阶段照旧去 browser-use 要
// 那三个文件，直接 missing runtime 挂掉。权威清单已收敛到 stage-official-plugins.mjs
// （与 official-plugin-definitions.ts 的 requiredSeedPaths 同源），这里只负责把插件的
// runtime 构建出来再暂存；dev 链路的构建校验仍归 scripts/build-desktop-agent-cli.mjs。
const isBootstrapWithRemote = process.env.ZCODE_BOOTSTRAP_WITH_REMOTE === "1";

function buildCliBundle() {
  console.log("[prepare:agent-bundle] building zcode-cli app-server bundle ...");
  // 复用仓库根脚本（turbo build:desktop-agent --filter=@zcode/cli），命中缓存时几乎瞬时。
  runCommand(process.execPath, [resolve(repoRoot, "scripts/build-desktop-agent-cli.mjs")], {
    cwd: repoRoot,
    env: pnpmRunEnv,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(
      `[prepare:agent-bundle] expected cli bundle missing after build: ${cliBundlePath}`,
    );
  }
}

function buildOfficialPluginRuntimes() {
  for (const plugin of OFFICIAL_PLUGIN_STAGING_LIST) {
    if (!plugin.requiresRuntime) continue;
    console.log(`[prepare:agent-bundle] building ${plugin.packageName} runtime ...`);
    if (isBootstrapWithRemote) {
      buildOfficialPluginRuntimeForBootstrap(plugin);
      assertOfficialPluginRuntime({ repoRoot, plugin });
      continue;
    }

    runCommand(
      "pnpm",
      ["--dir", resolve(repoRoot, "apps/zcode-cli"), "--filter", plugin.packageName, "build"],
      {
        cwd: repoRoot,
        env: pnpmRunEnv,
      },
    );
    assertOfficialPluginRuntime({ repoRoot, plugin });
  }
}

function buildOfficialPluginRuntimeForBootstrap(plugin) {
  const pluginRoot = resolve(repoRoot, plugin.relativePath);
  const hasCompleteRuntime = plugin.requiredRuntimePaths.every((relativePath) =>
    existsSync(resolve(pluginRoot, ...relativePath.split("/"))),
  );
  if (plugin.packageName !== BROWSER_USE_PLUGIN_PACKAGE_NAME && hasCompleteRuntime) {
    console.log(
      `[prepare:agent-bundle] reuse existing official plugin runtime: ${plugin.packageName}`,
    );
    return;
  }

  // bootstrap:with-remote 会连续构建 remote assets 和桌面 agent bundle。
  // 通过 pnpm/filter 进入插件 build 时，tsc shim 在本地低内存环境中容易被 SIGKILL；
  // 这里仅在 bootstrap 开关下用当前 Node 直接执行等价 tsc + build-mcp，不改变插件自身 build 脚本。
  // browser-use 的 server 与 browser-client 是同一发布对；即使旧 server.js 存在也必须重建，
  // 否则会把旧 server 与当前 client（或缺失 client）一起 stage 到桌面安装包。
  runCommand(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
    cwd: pluginRoot,
    env: process.env,
  });
  runCommand(process.execPath, [plugin.runtimeBuildScript], {
    cwd: pluginRoot,
    env: process.env,
  });
}

function stageBundle() {
  // 实现已抽到 stage-agent-bundle.mjs：dev 链（scripts/build-desktop-agent-cli.mjs）
  // 必须用同一份，否则 dev 会继续跑上一次打包留下的陈旧 agent。
  // stageAgentBundle 内部在清空重建后调用 stage-official-plugins.mjs 把官方插件
  // 一并写回 glm/packages/——清空与写回是同一个动作，这里不再有独立的插件暂存入口。
  stageAgentBundle({ repoRoot, platformKey });
}

// Electron 生产包只带 resources/glm/zcode.cjs 时，app-server 进程的
// __dirname 附近没有官方插件目录，启动时 seed 找不到 source，用户侧不会自动得到内置插件。
// 插件按 bootstrap 的 rootCandidates 期望放到 glm/packages/*-plugin，让 Electron Node
// 运行 zcode.cjs 时复用同一套 filesystem seed 逻辑；实现见 stage-official-plugins.mjs。
// browser-use runtime 的声明生成依赖 @zcode/core/dist。CI 干净检出没有该产物，
// 必须先构建 CLI 依赖，再构建官方插件；开发机残留的 dist 曾掩盖这个顺序问题。
buildCliBundle();
buildOfficialPluginRuntimes();
stageBundle();
