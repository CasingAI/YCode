import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 隔离浏览器夹具的宿主边界：Playwright / Chromium 发现、临时静态服务。
 * 不连接、不操作正在运行的 YCode，也不下载浏览器。
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DESKTOP_PACKAGE = resolve(HERE, "../../../../desktop/package.json");
const desktopRequire = createRequire(DESKTOP_PACKAGE);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".map": "application/json; charset=utf-8",
};

export async function loadPlaywright() {
  try {
    return desktopRequire("playwright-core");
  } catch {
    // CI 未安装桌面端依赖时显式跳过，不联网下载浏览器，也不改用其他浏览器通道。
    return undefined;
  }
}

export async function findChromium(bundledPath) {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  const directories = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.LOCALAPPDATA,
  ].filter(Boolean);
  const macApplications = home ? join(home, "Applications") : undefined;
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
    // macOS 的独立 Chrome / Chromium；不枚举系统默认浏览器或正在运行的 YCode。
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    macApplications
      ? join(macApplications, "Google Chrome.app", "Contents", "MacOS", "Google Chrome")
      : undefined,
    macApplications
      ? join(macApplications, "Chromium.app", "Contents", "MacOS", "Chromium")
      : undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 没有独立浏览器时显式跳过，不连接运行中的 YCode，也不下载浏览器。
    }
  }
  return undefined;
}

export function startStaticServer(root) {
  const server = createServer(async (request, response) => {
    try {
      const urlPath = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      const relative = normalize(urlPath).replace(/^([/\\])+/, "");
      let filePath = join(root, relative);
      try {
        const info = await stat(filePath);
        if (info.isDirectory()) filePath = join(filePath, "index.html");
      } catch {
        if (extname(relative)) {
          response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          response.end("not found");
          return;
        }
        filePath = join(root, "index.html");
      }
      const body = await readFile(filePath);
      response.writeHead(200, {
        "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(String(error));
    }
  });
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}
