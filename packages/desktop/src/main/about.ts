import type { BrowserWindow, MessageBoxReturnValue } from "electron";
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
import { createCustomAboutDialogHtml } from "./aboutWindow.js";

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
// 自定义 About 内容本体是 256x280；原生窗口如果同尺寸会让内容贴满透明窗口边界。
// 这里给 BrowserWindow 额外留出背景呼吸空间，避免正式 About 看起来比 demo 更局促。
const ABOUT_WINDOW_WIDTH = 256;
const ABOUT_WINDOW_HEIGHT = 312;
const ABOUT_MESSAGES: Record<
  Locale,
  {
    aboutTitle: string;
    versionLabel: string;
    okButtonLabel: string;
    optimizedForAppleSilicon: string;
    upstreamVersion: (version: string) => string;
    copyright: (year: number) => string;
  }
> = {
  "zh-CN": {
    aboutTitle: "关于 YCode",
    versionLabel: "版本",
    okButtonLabel: "确定",
    optimizedForAppleSilicon: "已针对 Apple Silicon 优化。",
    upstreamVersion: (version) => `上游 ZCode 版本 ${version}。`,
    copyright: (year) => `版权所有 © ${year} YCode。`,
  },
  "en-US": {
    aboutTitle: "About YCode",
    versionLabel: "version",
    okButtonLabel: "OK",
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

// 上游版本行紧跟优化行之后，取值与 UA 的 (like ZCode/x) 段同源。
// 之前关于面板不展示上游版本，用户无法从界面确认本发行版对齐的上游基线。
// 修复依据：根 package.json 的 zcodeUpstreamVersion 经编译期注入 ZCODE_UPSTREAM_VERSION，
// 与版本号注入链路同构（见 ycode-wire-user-agent-brand spec）；"unknown" 或空串时整行省略。
export function formatAboutUpstreamVersionLine(
  locale: Locale = DEFAULT_LOCALE,
  upstreamVersion: string = ZCODE_UPSTREAM_VERSION,
): string {
  const normalized = normalizeValue(upstreamVersion);
  if (normalized === "unknown") {
    return "";
  }
  return getAboutMessages(locale).upstreamVersion(normalized);
}

function formatAboutOptimizationLine(
  snapshot: Pick<AboutSnapshot, "osPlatform" | "osArch">,
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (snapshot.osPlatform === "darwin" && snapshot.osArch === "arm64") {
    return getAboutMessages(locale).optimizedForAppleSilicon;
  }

  return "";
}

function resolveAboutIconPath(isPackaged: boolean): string {
  return isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(import.meta.dirname, "../../build/icon.png");
}

export function createIconDataUrl(filePath: string): string {
  // 模板的 CSP 只放行 img-src data:，用 data URL 内联可以避免为了一张图
  // 放宽到 file:，也不依赖 BrowserWindow 的 webPreferences。
  if (!existsSync(filePath)) {
    return "";
  }

  try {
    return `data:image/png;base64,${readFileSync(filePath).toString("base64")}`;
  } catch {
    // 读取失败不能让关于面板整个打不开：降级成"没有图标"，其余内容照常渲染。
    return "";
  }
}

export function resolveAboutIconDataUrl(isPackaged: boolean): string {
  return createIconDataUrl(resolveAboutIconPath(isPackaged));
}

export async function showAboutDialog(
  parentWindow?: BrowserWindow,
  locale: Locale = DEFAULT_LOCALE,
): Promise<MessageBoxReturnValue> {
  const { app, BrowserWindow } = await import("electron");
  // buildMetadata 只读一次，既用于版本解析也用于 Commit / Build Time 等字段。
  const buildMetadata = readBuildMetadata();
  const snapshot = createAboutSnapshot({
    // 这里不能直接用 app.getVersion()：开发态它返回的是 Electron 运行壳版本，不是产品版本。
    // 详见 resolveAboutAppVersion 的注释。
    appVersion: resolveAboutAppVersion(buildMetadata, app.getVersion()),
    buildMetadata,
  });
  const aboutMessages = getAboutMessages(locale);
  // 之前只有 macOS 使用自绘 About，Windows/Linux 仍走原生 message box。
  // 问题原因：各平台原生消息框的排版、图标和按钮样式差异很大，无法复用 macOS 参考样式。
  // 这里统一使用自绘 modal，保证 About 的品牌展示和多语言文案在三端一致。
  const iconPath = resolveAboutIconPath(app.isPackaged);
  const aboutWindow = new BrowserWindow({
    width: ABOUT_WINDOW_WIDTH,
    height: ABOUT_WINDOW_HEIGHT,
    parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
    modal: Boolean(parentWindow && !parentWindow.isDestroyed()),
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: aboutMessages.aboutTitle,
    icon: existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  aboutWindow.setMenuBarVisibility(false);
  aboutWindow.once("ready-to-show", () => {
    aboutWindow.show();
  });
  void aboutWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      createCustomAboutDialogHtml({
        applicationName: ABOUT_APPLICATION_NAME,
        appVersion: snapshot.appVersion,
        copyright: formatAboutCopyright(undefined, locale),
        optimizationLine: formatAboutOptimizationLine(snapshot, locale),
        upstreamVersionLine: formatAboutUpstreamVersionLine(locale),
        versionLabel: aboutMessages.versionLabel,
        okButtonLabel: aboutMessages.okButtonLabel,
        iconDataUrl: resolveAboutIconDataUrl(app.isPackaged),
      }),
    )}`,
  );
  return { response: 0, checkboxChecked: false };
}
