import type { BrowserWindow } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { arch, hostname, platform, release, type, version as osVersion } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LOCALE,
  type Locale,
  ZCODE_BUILD_TIME,
  ZCODE_COMMIT,
  ZCODE_ENV,
  ZCODE_UPSTREAM_VERSION,
  ZCODE_VERSION,
} from "@zcode/shared";

interface DesktopBuildMetadata {
  appVersion?: string;
  buildCommitId?: string;
  buildTime?: string;
  electronBuilderVersion?: string;
}

interface AboutSnapshot {
  appVersion: string;
  buildCommitId: string;
  buildTime: string;
  environment: string;
  electronVersion: string;
  electronBuilderVersion: string;
  chromiumVersion: string;
  nodeVersion: string;
  v8Version: string;
  osType: string;
  osPlatform: string;
  osRelease: string;
  osVersion: string;
  osArch: string;
  hostname: string;
}

interface AboutSnapshotOptions {
  appVersion?: string;
  buildMetadata?: DesktopBuildMetadata | null;
  environment?: string;
  runtimeVersions?: Pick<NodeJS.ProcessVersions, "electron" | "chrome" | "node" | "v8">;
  osInfo?: {
    type: string;
    platform: string;
    release: string;
    version: string;
    arch: string;
    hostname: string;
  };
}

const ABOUT_APPLICATION_NAME = "YCode Desktop App";
const ABOUT_MESSAGES: Record<
  Locale,
  {
    optimizedForAppleSilicon: string;
    upstreamVersion: (version: string) => string;
    copyright: (year: number) => string;
  }
> = {
  "zh-CN": {
    optimizedForAppleSilicon: "已针对 Apple Silicon 优化。",
    upstreamVersion: (version) => `上游 ZCode 版本 ${version}。`,
    copyright: (year) => `版权所有 © ${year} YCode。`,
  },
  "en-US": {
    optimizedForAppleSilicon: "Optimized for Apple Silicon.",
    upstreamVersion: (version) => `Upstream ZCode version ${version}.`,
    copyright: (year) => `Copyright © ${year} YCode.`,
  },
};

function normalizeValue(value: string | undefined | null): string {
  if (typeof value !== "string") {
    return "unknown";
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

function normalizePackageVersion(version: string | undefined): string {
  const normalized = normalizeValue(version);
  return normalized === "unknown" ? normalized : normalized.replace(/^[^\d]*/, "") || normalized;
}

function getAboutMessages(locale: Locale): (typeof ABOUT_MESSAGES)[Locale] {
  return ABOUT_MESSAGES[locale] ?? ABOUT_MESSAGES[DEFAULT_LOCALE];
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function resolveBuildMetadataPath(): string {
  return join(import.meta.dirname, "../metadata/build-meta.json");
}

export function readBuildMetadata(
  filePath = resolveBuildMetadataPath(),
): DesktopBuildMetadata | null {
  // 之前 About 直接读取编译时注入的常量，commit/time 只能代表 tsup 那一刻。
  // 问题原因：构建和打包是分步执行的，安装包里的 about 需要的是“最终产物”的统一元数据，而不是某个编译子步骤的快照。
  // 这里优先读打包前生成的 build-meta.json；只有缺文件时才回退到编译时常量。
  return readJsonFile<DesktopBuildMetadata>(filePath);
}

export function resolveAboutAppVersion(
  buildMetadata: DesktopBuildMetadata | null,
  electronAppVersion: string,
  compiledVersion: string = ZCODE_VERSION,
): string {
  // 之前 showAboutDialog 直接把 app.getVersion() 当版本号展示，开发态下显示的是 Electron 版本。
  // 问题原因：Electron 的 app.getVersion() 读应用 package.json 的 version，读不到就回退到当前
  // bundle / executable 的版本。Desktop 是 workspace 内部包，packages/desktop/package.json 没有
  // version 字段，开发壳 Info.plist 里也只有 Electron 自身的版本，于是命中回退分支（例如 41.0.3）。
  // 修复依据：产品版本的权威来源是根 package.json，它经 build-metadata.mjs 落到 build-meta.json，
  // 再由 tsup/vite 注入 ZCODE_VERSION。所以按「打包元数据 → 编译期常量 → app.getVersion() 兜底」
  // 取值；用 || 而非 ??，让空串也能继续回退，避免展示空版本号。
  // compiledVersion 允许注入，是为了让三级回退顺序在单测里可覆盖：非构建环境下模块常量恒为
  // "0.0.0-dev"，末级分支无法通过真实编译常量触达。
  return buildMetadata?.appVersion || compiledVersion || electronAppVersion;
}

function resolveElectronBuilderVersion(buildMetadata: DesktopBuildMetadata | null): string {
  if (buildMetadata?.electronBuilderVersion) {
    return normalizeValue(buildMetadata.electronBuilderVersion);
  }

  const packageJson = readJsonFile<{ devDependencies?: Record<string, string> }>(
    join(import.meta.dirname, "../../package.json"),
  );
  return normalizePackageVersion(packageJson?.devDependencies?.["electron-builder"]);
}

export function createAboutSnapshot(options: AboutSnapshotOptions = {}): AboutSnapshot {
  const buildMetadata = options.buildMetadata ?? null;
  const runtimeVersions = options.runtimeVersions ?? process.versions;
  const osInfo = options.osInfo ?? {
    type: type(),
    platform: platform(),
    release: release(),
    version: osVersion(),
    arch: arch(),
    hostname: hostname(),
  };

  return {
    appVersion: normalizeValue(options.appVersion ?? buildMetadata?.appVersion ?? ZCODE_VERSION),
    buildCommitId: normalizeValue(buildMetadata?.buildCommitId ?? ZCODE_COMMIT),
    buildTime: normalizeValue(buildMetadata?.buildTime ?? ZCODE_BUILD_TIME),
    environment: normalizeValue(options.environment ?? ZCODE_ENV),
    electronVersion: normalizeValue(runtimeVersions.electron),
    electronBuilderVersion: resolveElectronBuilderVersion(buildMetadata),
    chromiumVersion: normalizeValue(runtimeVersions.chrome),
    nodeVersion: normalizeValue(runtimeVersions.node),
    v8Version: normalizeValue(runtimeVersions.v8),
    osType: normalizeValue(osInfo.type),
    osPlatform: normalizeValue(osInfo.platform),
    osRelease: normalizeValue(osInfo.release),
    osVersion: normalizeValue(osInfo.version),
    osArch: normalizeValue(osInfo.arch),
    hostname: normalizeValue(osInfo.hostname),
  };
}

export function formatAboutDetail(snapshot: AboutSnapshot): string {
  return [
    `Version: ${snapshot.appVersion}`,
    `Commit: ${snapshot.buildCommitId}`,
    `Build Time: ${snapshot.buildTime}`,
    `Environment: ${snapshot.environment}`,
    "",
    `Electron: ${snapshot.electronVersion}`,
    `Electron Builder: ${snapshot.electronBuilderVersion}`,
    `Chromium: ${snapshot.chromiumVersion}`,
    `Node.js: ${snapshot.nodeVersion}`,
    `V8: ${snapshot.v8Version}`,
    "",
    `OS Type: ${snapshot.osType}`,
    `OS Platform: ${snapshot.osPlatform}`,
    `OS Release: ${snapshot.osRelease}`,
    `OS Version: ${snapshot.osVersion}`,
    `OS Arch: ${snapshot.osArch}`,
    `Hostname: ${snapshot.hostname}`,
  ].join("\n");
}

function formatAboutCopyright(
  year = new Date().getFullYear(),
  locale: Locale = DEFAULT_LOCALE,
): string {
  return getAboutMessages(locale).copyright(year);
}

function formatAboutCredits(
  snapshot: Pick<AboutSnapshot, "osPlatform" | "osArch">,
  locale: Locale,
): string {
  const messages = getAboutMessages(locale);
  const credits: string[] = [];
  if (snapshot.osPlatform === "darwin" && snapshot.osArch === "arm64") {
    credits.push(messages.optimizedForAppleSilicon);
  }

  const upstreamVersion = normalizeValue(ZCODE_UPSTREAM_VERSION);
  if (upstreamVersion !== "unknown") {
    credits.push(messages.upstreamVersion(upstreamVersion));
  }
  return credits.join("\n");
}

function resolveAboutIconPath(isPackaged: boolean): string {
  return isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(import.meta.dirname, "../../build/icon.png");
}

export function buildAboutPanelOptions(
  snapshot: AboutSnapshot,
  options: { locale: Locale; isPackaged: boolean; platform: NodeJS.Platform },
): Record<string, unknown> {
  const commonOptions = {
    applicationName: ABOUT_APPLICATION_NAME,
    applicationVersion: snapshot.appVersion,
    copyright: formatAboutCopyright(undefined, options.locale),
    iconPath: resolveAboutIconPath(options.isPackaged),
  };
  if (options.platform === "linux") {
    return { ...commonOptions, authors: ["YCode"], website: "https://github.com/CasingAI/YCode" };
  }
  return { ...commonOptions, credits: formatAboutCredits(snapshot, options.locale) };
}

export async function showAboutDialog(
  _parentWindow?: BrowserWindow,
  locale: Locale = DEFAULT_LOCALE,
): Promise<void> {
  const { app } = await import("electron");
  // buildMetadata 只读一次，版本解析与导出诊断信息共用同一份元数据。
  const buildMetadata = readBuildMetadata();
  const snapshot = createAboutSnapshot({
    appVersion: resolveAboutAppVersion(buildMetadata, app.getVersion()),
    buildMetadata,
  });
  // 修复依据：自建窗口需自行同步 parent、modal 与 sheet 关闭时序，曾导致面板无法关闭；
  // Electron 原生 About API 将展示和关闭生命周期交给操作系统。
  app.setAboutPanelOptions(
    buildAboutPanelOptions(snapshot, {
      locale,
      isPackaged: app.isPackaged,
      platform: process.platform,
    }),
  );
  await app.showAboutPanel();
}
