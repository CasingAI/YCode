import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findChromium, loadPlaywright, startStaticServer } from "./harness.mjs";
import { runCoreScenarios } from "./scenarios-core.mjs";
import { runResponsiveScenarios } from "./scenarios-responsive.mjs";

/**
 * 文件编辑器 Markdown 源码/预览切换的隔离交互验证入口。
 *
 * 真实：FilesEditorGroupPane、FilesEditorTabBar、filesEditorStore、按视图布局、生产 Markdown 渲染。
 * 边界：i18n/settings/toast/logger/应用 store、Monaco 外壳、非 Markdown 预览、大文本查看器。
 * 只启动本脚本自己的 Vite 构建与无头 Chromium；不连接、不操作正在运行的 YCode。
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));

async function main() {
  const result = {
    assertions: [],
    screenshots: [],
    skipped: false,
    skipReason: undefined,
    pageErrors: [],
    consoleErrors: [],
    failedResources: [],
    buildDir: undefined,
    origin: undefined,
  };
  const check = (name, ok, detail) => {
    result.assertions.push({ name, ok, detail });
    return ok;
  };

  let browser;
  let server;
  let buildDir;
  try {
    // 先确认浏览器能力，再构建；无浏览器环境不产生构建副作用。
    const playwright = await loadPlaywright();
    if (!playwright) {
      result.skipped = true;
      result.skipReason =
        "未加载 playwright-core；跳过隔离浏览器验证，不影响无浏览器环境的其他 UI 测试";
      return result;
    }
    const { chromium } = playwright;
    const executablePath = await findChromium(chromium.executablePath());
    if (!executablePath) {
      result.skipped = true;
      result.skipReason =
        "未找到独立 Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑 Markdown 模式交互验证";
      return result;
    }

    const { build } = await import("vite");
    buildDir = await mkdtemp(join(tmpdir(), "zcode-files-md-e2e-dist-"));
    result.buildDir = buildDir;
    await build({
      configFile: join(HERE, "vite.config.mts"),
      logLevel: "silent",
      build: { outDir: buildDir, emptyOutDir: true },
    });

    server = await startStaticServer(buildDir);
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}/`;
    result.origin = origin;

    const shotDir = await mkdtemp(join(tmpdir(), "zcode-files-md-e2e-shots-"));
    const shot = async (page, name) => {
      const path = join(shotDir, `${name}.png`);
      await page.screenshot({ path, fullPage: false });
      result.screenshots.push(path);
      return path;
    };

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (error) => result.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") result.consoleErrors.push(message.text());
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        result.failedResources.push(`${response.status()} ${response.url()}`);
      }
    });
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean(window.__filesE2E?.mount), undefined, {
      timeout: 15_000,
    });

    const mount = async (scenario) => {
      await page.evaluate((value) => window.__filesE2E.mount(value), scenario);
      await page.waitForSelector('[data-files-e2e-ready="true"]', { timeout: 15_000 });
    };
    const snapshot = () => page.evaluate(() => window.__filesE2E.snapshot());
    const pathInfo = (path) =>
      page.evaluate(
        (targetPath) => ({
          viewId: window.__filesE2E.viewIdForPath(targetPath),
          groupId: window.__filesE2E.groupIdForPath(targetPath),
        }),
        path,
      );

    const context = { page, check, shot, mount, snapshot, pathInfo };
    await runCoreScenarios(context);
    await runResponsiveScenarios(context);

    const ignoredConsoleErrors = result.consoleErrors.filter(
      (message) =>
        !/favicon|Failed to load resource: the server responded with a status of 404/i.test(
          message,
        ),
    );
    check("runtime: pageerror 为空", result.pageErrors.length === 0, result.pageErrors);
    check("runtime: console.error 为空", ignoredConsoleErrors.length === 0, ignoredConsoleErrors);
    check(
      "runtime: 没有 4xx/5xx 资源",
      result.failedResources.length === 0,
      result.failedResources,
    );

    return result;
  } catch (error) {
    result.assertions.push({
      name: "执行异常",
      ok: false,
      detail: String(error instanceof Error ? (error.stack ?? error.message) : error),
    });
    return result;
  } finally {
    await browser?.close().catch(() => {});
    await new Promise((resolveClose) => {
      if (!server) return resolveClose();
      server.close(() => resolveClose());
    });
    if (buildDir && process.env.FILES_MD_E2E_KEEP !== "1") {
      await rm(buildDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function report(result) {
  console.log("FILES_MD_E2E_RESULT_JSON", JSON.stringify(result));
  const failures = result.assertions.filter((entry) => !entry.ok);
  if (result.skipped) {
    console.log(`SKIP: ${result.skipReason}`);
  } else if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL: ${failure.name}`);
      if (failure.detail !== undefined) {
        console.error(`  ${JSON.stringify(failure.detail)}`);
      }
    }
    console.error(
      `结果: ${result.assertions.length - failures.length}/${result.assertions.length} 通过`,
    );
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${result.assertions.length}/${result.assertions.length}`);
    for (const screenshot of result.screenshots) {
      console.log(`截图: ${screenshot}`);
    }
  }
}

export { main };

const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const result = await main();
  report(result);
  assert.ok(result.skipped || result.assertions.every((entry) => entry.ok));
}
