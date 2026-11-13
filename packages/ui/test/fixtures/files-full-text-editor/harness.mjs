import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildLargeJsonFixture } from "./generate.mjs";

/**
 * 隔离夹具的宿主边界：临时静态服务 + 只在本进程内保存的 9.7 MiB 文件。
 *
 * 文件服务用 HTTP 窗口端点模拟 `IFileService.readTextFileWindow` /
 * `commitTextFile` 的边界（版本、总大小、按字节窗口、EOF），这样浏览器里的
 * 生产读取决策、Store、GroupPane 与真实 Monaco 都走同一条路径。
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
  ".wasm": "application/wasm",
};

const FILE_TEXT_WINDOW_MAX_BYTES = 256 * 1024;
const FILE_TEXT_WINDOW_CHANGED_CODE = "FILE_TEXT_WINDOW_CHANGED";
const FILE_TEXT_WINDOW_INVALID_RANGE_CODE = "FILE_TEXT_WINDOW_INVALID_RANGE";
const FILE_TEXT_COMMIT_CONFLICT_CODE = "FILE_TEXT_COMMIT_CONFLICT";
const FILE_TEXT_INVALID_PATCH_CODE = "FILE_TEXT_INVALID_PATCH";

export async function loadPlaywright() {
  try {
    return desktopRequire("playwright-core");
  } catch {
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

/** 进程内唯一的「磁盘文件」：初始 9.7 MiB JSON，commit 后替换并提升版本。 */
export function createFixtureFile() {
  const generated = buildLargeJsonFixture();
  const state = {
    bytes: Buffer.from(generated.text, "utf8"),
    version: "v1",
    commits: [],
    windowReads: [],
  };
  return {
    generated,
    get bytes() {
      return state.bytes;
    },
    get version() {
      return state.version;
    },
    get commits() {
      return state.commits;
    },
    get windowReads() {
      return state.windowReads;
    },
    get text() {
      return state.bytes.toString("utf8");
    },
    reset() {
      state.bytes = Buffer.from(generated.text, "utf8");
      state.version = "v1";
      state.commits.length = 0;
      state.windowReads.length = 0;
    },
    commit(params) {
      const write = params?.write;
      if (!write || (write.kind !== "full" && write.kind !== "patches")) {
        throw Object.assign(new Error("invalid write"), { code: FILE_TEXT_INVALID_PATCH_CODE });
      }
      if (params.expectedVersion !== state.version) {
        throw Object.assign(new Error("version conflict"), {
          code: FILE_TEXT_COMMIT_CONFLICT_CODE,
        });
      }
      if (write.kind === "patches") {
        throw Object.assign(new Error("fixture 只验证完整正文提交"), {
          code: FILE_TEXT_INVALID_PATCH_CODE,
        });
      }
      state.bytes = Buffer.from(write.text, "utf8");
      state.version = `v${state.commits.length + 2}`;
      state.commits.push({ version: state.version, totalBytes: state.bytes.length });
      return { path: params.path, version: state.version, totalBytes: state.bytes.length };
    },
    readWindow(params) {
      const offset = Math.max(0, Math.trunc(params?.offset ?? 0));
      const requestedLength = Math.trunc(params?.length ?? FILE_TEXT_WINDOW_MAX_BYTES);
      const length = Math.min(Math.max(requestedLength, 4), FILE_TEXT_WINDOW_MAX_BYTES);
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(requestedLength) ||
        offset < 0 ||
        offset > state.bytes.length ||
        requestedLength <= 0
      ) {
        throw Object.assign(new Error("invalid range"), {
          code: FILE_TEXT_WINDOW_INVALID_RANGE_CODE,
        });
      }
      if (params.expectedVersion !== undefined && params.expectedVersion !== state.version) {
        throw Object.assign(new Error("version changed"), {
          code: FILE_TEXT_WINDOW_CHANGED_CODE,
        });
      }
      const end = Math.min(offset + length, state.bytes.length);
      const chunk = state.bytes.subarray(offset, end);
      let content = "";
      let hasDecodingErrors = false;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(chunk);
      } catch {
        hasDecodingErrors = true;
        content = new TextDecoder("utf-8").decode(chunk);
      }
      const window = {
        path: params.path,
        offset,
        content,
        bytesRead: end - offset,
        nextOffset: end,
        totalBytes: state.bytes.length,
        version: state.version,
        isBinary: false,
        hasDecodingErrors,
        eof: end === state.bytes.length,
        truncated: end < state.bytes.length,
      };
      state.windowReads.push({ offset, length, bytesRead: window.bytesRead });
      return window;
    },
  };
}

function readJsonBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      try {
        resolveBody(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

export function startFixtureServer({ root, fixture, meta }) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/__fixture/meta") {
        sendJson(response, 200, meta);
        return;
      }
      if (url.pathname === "/__fixture/window") {
        try {
          const window = fixture.readWindow({
            path: url.searchParams.get("path") ?? meta.path,
            offset: Number(url.searchParams.get("offset") ?? 0),
            length: Number(url.searchParams.get("length") ?? FILE_TEXT_WINDOW_MAX_BYTES),
            expectedVersion: url.searchParams.get("expectedVersion") ?? undefined,
          });
          sendJson(response, 200, window);
        } catch (error) {
          sendJson(response, 409, { code: error.code, message: error.message });
        }
        return;
      }
      if (url.pathname === "/__fixture/commit" && request.method === "POST") {
        try {
          const params = await readJsonBody(request);
          sendJson(response, 200, fixture.commit(params));
        } catch (error) {
          sendJson(response, 409, { code: error.code, message: error.message });
        }
        return;
      }

      const urlPath = decodeURIComponent(url.pathname);
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
