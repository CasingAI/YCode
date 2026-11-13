import { createServer } from "node:http";
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadChromium, repoRoot } from "../../helpers/chromiumFixture.js";
import { runModeScenarios } from "./scenarios.js";
import { runStaticChecks } from "./static-checks.js";
import type { Assertion, Check, Metrics } from "./scenario-types.js";

/**
 * Radix Viewport 固定样式重复写入的独立生产态浏览器验证。
 *
 * 真实：node_modules 中 @radix-ui/react-select@2.2.6 与
 * @radix-ui/react-scroll-area@1.2.10 的 ESM / CJS 实际构建入口。
 * 只启动本脚本自己的 Vite 构建、静态服务与无头 Chromium；不连接、不注入、
 * 不关闭、不重启正在运行的 YCode，也不下载浏览器。
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export type RunResult = {
  assertions: Assertion[];
  consoleErrors: string[];
  metrics: Metrics;
  pageErrors: string[];
  skipped: boolean;
  skipReason?: string;
};

function startStaticServer(root: string): Promise<ReturnType<typeof createServer>> {
  const server = createServer(async (request, response) => {
    try {
      const urlPath = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      const relative = urlPath.replace(/^([/\\])+/, "");
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

async function writeResultFile(result: RunResult): Promise<void> {
  const file = process.env.RADIX_VIEWPORT_RESULT_FILE;
  if (!file) return;
  const label = process.env.RADIX_VIEWPORT_RESULT_LABEL ?? "run";
  try {
    await appendFile(
      file,
      `${JSON.stringify({ label, recordedAt: new Date().toISOString(), result }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // 结果文件只是临时证据，不阻断测试本身。
  }
}

export async function main(): Promise<RunResult> {
  const result: RunResult = {
    assertions: [],
    consoleErrors: [],
    metrics: {},
    pageErrors: [],
    skipped: false,
  };
  const check: Check = (name, ok, detail) => {
    result.assertions.push({ detail, name, ok });
    return ok;
  };

  let browser: Awaited<ReturnType<typeof import("playwright-core").chromium.launch>> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let buildDir: string | undefined;
  try {
    const chromiumInfo = await loadChromium();
    if (!chromiumInfo) {
      result.skipped = true;
      result.skipReason =
        "未找到独立 Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑 Radix Viewport 验证";
      return result;
    }

    await runStaticChecks(check, result.metrics, repoRoot);

    const { build } = await import("vite");
    buildDir = await mkdtemp(join(tmpdir(), "zcode-radix-viewport-dist-"));
    await build({
      build: { emptyOutDir: true, outDir: buildDir },
      configFile: join(HERE, "vite.config.mts"),
      logLevel: "silent",
    });

    server = await startStaticServer(buildDir);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("静态服务未取得端口");
    const origin = `http://127.0.0.1:${address.port}/`;

    browser = await chromiumInfo.chromium.launch({
      executablePath: chromiumInfo.executablePath,
      headless: true,
    });

    for (const mode of ["esm", "cjs"] as const) {
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      const page = await browser.newPage({ viewport: { height: 800, width: 1280 } });
      page.on("pageerror", (error) => {
        pageErrors.push(error.message);
        result.pageErrors.push(`${mode}: ${error.message}`);
      });
      page.on("console", (message) => {
        if (message.type() === "error") {
          const text = message.text();
          // 无 favicon 的独立夹具会产生一条无关 404，不算运行错误。
          if (
            /favicon|Failed to load resource: the server responded with a status of 404/i.test(text)
          ) {
            return;
          }
          consoleErrors.push(text);
          result.consoleErrors.push(`${mode}: ${text}`);
        }
      });
      await page.goto(`${origin}?entry=${mode}`, { waitUntil: "networkidle" });
      await runModeScenarios(page, mode, check, result.metrics);
      check(`${mode}: pageerror 为空`, pageErrors.length === 0, pageErrors);
      check(`${mode}: console.error 为空`, consoleErrors.length === 0, consoleErrors);
      await page.close();
    }

    return result;
  } catch (error) {
    result.assertions.push({
      detail: String(error instanceof Error ? (error.stack ?? error.message) : error),
      name: "执行异常",
      ok: false,
    });
    return result;
  } finally {
    await browser?.close().catch(() => {});
    await new Promise<void>((resolveClose) => {
      if (!server) return resolveClose();
      server.close(() => resolveClose());
    });
    if (buildDir) await rm(buildDir, { force: true, recursive: true }).catch(() => {});
    await writeResultFile(result);
  }
}
