import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 独立浏览器测试的公共启动逻辑：只使用测试自己的 Chromium，
// 不连接、不下载、不操作正在运行的 YCode。

export const uiRoot = fileURLToPath(new URL("../../", import.meta.url));
export const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const desktopRequire = createRequire(new URL("../../../desktop/package.json", import.meta.url));

export async function findChromium(bundledPath: string): Promise<string | undefined> {
  const directories = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.LOCALAPPDATA,
  ].filter((value): value is string => Boolean(value));
  const candidates = [
    process.env.ZCODE_TEST_CHROMIUM_PATH,
    process.env.CHROME_BIN,
    process.env.CHROMIUM_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    bundledPath,
    ...directories.flatMap((directory) => [
      join(directory, "Google", "Chrome", "Application", "chrome.exe"),
      join(directory, "Chromium", "Application", "chrome.exe"),
    ]),
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 未安装独立浏览器时显式跳过，不连接运行中的应用或下载浏览器。
    }
  }
  return undefined;
}

export async function resolveSource(candidate: string): Promise<string | undefined> {
  const stem = candidate.endsWith(".js") ? candidate.slice(0, -3) : candidate;
  for (const file of [
    candidate,
    ...[".ts", ".tsx", ".js", ".json"].map((ext) => `${stem}${ext}`),
  ]) {
    try {
      await access(file);
      return file;
    } catch {
      // 源码的 .js 导入在隔离 fixture 中解析到对应 TypeScript 文件。
    }
  }
  return undefined;
}

export async function loadChromium(): Promise<
  | {
      chromium: typeof import("playwright-core").chromium;
      executablePath: string;
    }
  | undefined
> {
  const { chromium } = desktopRequire("playwright-core") as typeof import("playwright-core");
  const executablePath = await findChromium(chromium.executablePath());
  return executablePath ? { chromium, executablePath } : undefined;
}
