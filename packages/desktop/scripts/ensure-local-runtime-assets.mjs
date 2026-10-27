#!/usr/bin/env node

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  resolveNativeSearchBuildPlan,
  resolveNativeSearchReleasePlan,
} from "../../../scripts/native-search-tools-config.mjs";
import { verifyBuiltNativeSearchTools } from "../../../scripts/native-search-tools-verify.mjs";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { getTargetPlatform } from "./target-platform.mjs";
import {
  CLOUDFLARED_VERSION,
  cloudflaredBinaryFileName,
  hasBundledCloudflared,
} from "./cloudflared-release-plan.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const target = getTargetPlatform();
const bundledToolsRoot = join(desktopRoot, "bundled-tools", target.key);
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
  platform: target.os,
  arch: target.arch,
});
const nativeSearchBuildPlan = nativeSearchReleasePlan.enabled
  ? resolveNativeSearchBuildPlan({
      platform: target.os,
      arch: target.arch,
      outputDir: bundledToolsRoot,
    })
  : undefined;
// Windows Chrome 导入入口未启用，默认 dev 启动不应把可选 helper 当成本地必需资源。
// 显式 opt-in 时继续沿用原有按需构建，避免删除未来恢复所需代码。
const shouldRequireWindowsBrowserImportHelper =
  target.os === "win32" && process.env.ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT === "1";
// CUA 权限浮窗靠 zcode-window-bounds 读系统设置窗口 bounds 才能吸附。该 Swift 产物被
// .gitignore 排除（仓库卫生门禁禁产物入库），生产链 prepare:runtime-assets 会在 darwin 上编它，
// dev 链也必须 ensure —— 新 checkout、换 worktree 或清过 resources 后二进制缺失，watcher spawn
// ENOENT 后 fail-open：浮窗照常显示、只是不再跟随系统设置窗口，且全程无报错，问题只能靠翻日志发现。
// 缺 Xcode CLT 时 build 脚本自身 warn 后 exit 0，这里仍保持 not ready，至多每次 dev 多跑一次秒级脚本。
const shouldRequireMacosWindowBounds = target.os === "darwin";

function isNativeSearchReady() {
  if (!nativeSearchBuildPlan) return true;
  const requiredPaths = nativeSearchReleasePlan.runtimeToolIds.map(
    (toolId) => nativeSearchBuildPlan.binaries[toolId],
  );
  if (requiredPaths.some((binaryPath) => !binaryPath || !existsSync(binaryPath))) {
    return false;
  }

  try {
    verifyBuiltNativeSearchTools({
      bfsPath: nativeSearchBuildPlan.bfsPath,
      rgPath: nativeSearchBuildPlan.rgPath,
      ugrepPath: nativeSearchBuildPlan.ugrepPath,
      platform: nativeSearchBuildPlan.platform,
      arch: nativeSearchBuildPlan.arch,
    });
    return true;
  } catch (error) {
    // native sidecar 不进 Git，切分支后可能留下版本、架构或 ABI 已过期的文件。
    // 复用正式构建 verifier 判定 ready，避免仅凭路径存在继续运行旧产物。
    console.warn(
      `[ensure-local-runtime-assets] embedded search validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    // ABI 或功能合同校验失败时清除生成物，确保下一次 prepare 从仓库归档重新解压。
    for (const binaryPath of requiredPaths) {
      rmSync(binaryPath, { force: true });
    }
    return false;
  }
}

const REQUIRED_LOCAL_RUNTIME_ASSETS = [
  {
    // cloudflared 内置二进制（2026.10.4）：公网临时链接的隧道实现。
    // 它是**可选**能力——下载失败不该挡住 dev 启动，功能降级为"未内置"提示即可，
    // 所以这里标 optional，准备失败只告警。
    label: "cloudflared bundled binary",
    script: "prepare:cloudflared",
    optional: true,
    isReady: () => {
      // 上游没有该平台资产时没有东西可准备，直接视为就绪（避免每次 dev 都空跑一遍）。
      if (!hasBundledCloudflared(target.key)) return true;
      const dir = join(bundledToolsRoot, "cloudflared");
      const binary = join(dir, cloudflaredBinaryFileName(target.key));
      if (!existsSync(binary)) return false;
      try {
        return readFileSync(join(dir, "VERSION"), "utf8").trim() === CLOUDFLARED_VERSION;
      } catch {
        return false;
      }
    },
  },
  {
    // CLI Proxy 内置二进制（8.0.27）：干净检出后直接 dev 也要有二进制可用，
    // 否则开发态只能走联网下载兜底。VERSION 与钉死版本比对，不符即重跑准备脚本。
    label: "cli-proxy bundled binary",
    script: "prepare:cli-proxy",
    isReady: () => {
      const dir = join(bundledToolsRoot, "cli-proxy");
      const binary = join(dir, target.key.startsWith("win32") ? "cli-proxy-api.exe" : "cli-proxy-api");
      if (!existsSync(binary)) return false;
      try {
        return readFileSync(join(dir, "VERSION"), "utf8").trim() === "8.0.27";
      } catch {
        return false;
      }
    },
  },
  ...(nativeSearchReleasePlan.enabled
    ? [
        {
          label: "embedded search",
          script: "prepare:native-search",
          isReady: isNativeSearchReady,
        },
      ]
    : []),
  ...(shouldRequireWindowsBrowserImportHelper
    ? [
        {
          label: "Windows browser import helper",
          script: "prepare:browser-import-helper",
          isReady: () =>
            existsSync(join(bundledToolsRoot, "browser-import", "zcode-browser-import-helper.exe")),
        },
      ]
    : []),
  ...(shouldRequireMacosWindowBounds
    ? [
        {
          label: "macOS window bounds helper",
          script: "prepare:macos-window-bounds",
          isReady: () =>
            existsSync(
              join(desktopRoot, "resources", "macos-window-bounds", "zcode-window-bounds"),
            ),
        },
      ]
    : []),
];

const missingAssets = [];
for (const asset of REQUIRED_LOCAL_RUNTIME_ASSETS) {
  if (!(await asset.isReady())) {
    missingAssets.push(asset);
  }
}

if (missingAssets.length === 0) {
  console.log(`[ensure-local-runtime-assets] all local runtime assets are ready for ${target.key}`);
  process.exit(0);
}

// 开发态需要在 Electron 启动前发现缺失的本地 sidecar/helper，而不是等到真正使用时才报错。
// 这里在 Electron 启动前只自检当前开发路径需要的 embedded search sidecar 和平台 helper。
// Agent bundle 由后续 build-desktop-agent-cli 构建，开发态 resolver 优先使用 workspace dist，
// 不在此自检范围。
for (const asset of missingAssets) {
  console.log(
    `[ensure-local-runtime-assets] preparing ${asset.label} because local runtime asset is missing or incomplete`,
  );
  try {
    runCommand(pnpmCommand, [asset.script], {
      cwd: desktopRoot,
      env: process.env,
    });
  } catch (error) {
    // 可选资产准备失败不挡 dev 启动：对应能力降级为"未内置"，用户侧会看到明确提示。
    if (!asset.optional) throw error;
    console.warn(
      `[ensure-local-runtime-assets] optional asset ${asset.label} failed to prepare: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
