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

/**
 * 进程内的「磁盘文件」：初始内容来自指定生成器，commit 后替换并提升版本。
 *
 * 同一份实现服务 9.7 MiB / 50 MiB / 10 MiB 单行三个场景；每个路径一个实例，
 * 版本、提交历史和窗口读取计数互不影响。
 */
export function createFixtureFile(generated = buildLargeJsonFixture()) {
  const state = {
    bytes: Buffer.from(generated.text, "utf8"),
    version: "v1",
    commits: [],
    windowReads: [],
    commitDelayMs: 0,
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
    get commitDelayMs() {
      return state.commitDelayMs;
    },
    /** 保存性能场景用它拉长 commit 往返，从而在 await 期间继续输入。 */
    setCommitDelay(ms) {
      state.commitDelayMs = Math.max(0, Math.trunc(ms));
    },
    reset() {
      state.bytes = Buffer.from(generated.text, "utf8");
      state.version = "v1";
      state.commits.length = 0;
      state.windowReads.length = 0;
      state.commitDelayMs = 0;
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

/**
 * 静态服务 + 多文件窗口 / 提交端点。
 *
 * `files` 是路径到 `{ fixture, meta }` 的映射；`defaultPath` 只用于没有显式
 * path 的探针请求。每个路径的文件状态完全独立。
 */
export function startFixtureServer({ root, files, defaultPath }) {
  const resolveFile = (pathValue) => {
    const path = pathValue ?? defaultPath;
    const entry = files.get(path);
    if (!entry) {
      throw Object.assign(new Error(`unknown fixture path: ${path}`), { code: "ENOENT" });
    }
    return { path, entry };
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/__fixture/meta") {
        try {
          const { entry } = resolveFile(url.searchParams.get("path") ?? undefined);
          sendJson(response, 200, entry.meta);
        } catch (error) {
          sendJson(response, 404, { code: error.code, message: error.message });
        }
        return;
      }
      if (url.pathname === "/__fixture/window") {
        try {
          const { path, entry } = resolveFile(url.searchParams.get("path") ?? undefined);
          const window = entry.fixture.readWindow({
            path,
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
          const { entry } = resolveFile(params?.path);
          if (entry.fixture.commitDelayMs > 0) {
            await new Promise((resolveDelay) =>
              setTimeout(resolveDelay, entry.fixture.commitDelayMs),
            );
          }
          sendJson(response, 200, entry.fixture.commit(params));
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
