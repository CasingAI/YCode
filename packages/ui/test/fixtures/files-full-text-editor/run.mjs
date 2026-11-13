import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  E2E_PATH,
  LEGACY_BLOCK_STEP,
  LEGACY_LARGE_FILE_BYTES,
  TARGET_BYTES,
  TARGET_LINES,
  TOKENS,
} from "./constants.mjs";
import {
  createFixtureFile,
  findChromium,
  loadPlaywright,
  startFixtureServer,
} from "./harness.mjs";
import { runEditorScenarios } from "./scenario-editor.mjs";
import { runPersistenceScenarios } from "./scenario-persistence.mjs";

/**
 * 完整正文编辑器的隔离浏览器验证入口。
 *
 * 真实：生产读取决策（readFilesTextForOpen）、Files Editor Store、真实
 * FilesEditorGroupPane / FilesEditorTabBar / FilesMonacoEditor（monaco-editor）、
 * 生产保存（saveFilesTextBuffer -> commitTextFile）、生产恢复（localStorage +
 * IndexedDB 大草稿）。
 * 边界：i18n / settings / toast / logger / 应用 store / 平台、非文本预览分支，
 * 以及进程内用 HTTP 窗口端点模拟的 IFileService。
 *
 * 只启动本脚本自己的 Vite 构建、静态服务和独立无头 Chromium；
 * 不连接、不操作正在运行的 YCode。
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));

function report(result) {
  console.log("FILES_FULL_TEXT_E2E_RESULT_JSON", JSON.stringify(result));
  const failures = result.assertions.filter((entry) => !entry.ok);
  if (result.skipped) {
    console.log(`SKIP: ${result.skipReason}`);
  } else if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL: ${failure.name}`);
      if (failure.detail !== undefined) console.error(`  ${JSON.stringify(failure.detail)}`);
    }
    console.error(
      `结果: ${result.assertions.length - failures.length}/${result.assertions.length} 通过`,
    );
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${result.assertions.length}/${result.assertions.length}`);
    for (const screenshot of result.screenshots) console.log(`截图: ${screenshot}`);
  }
}

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
  const confirm = (name, condition, detail) => {
    if (!check(name, Boolean(condition), condition ? undefined : detail)) {
      const error = new Error(`断言失败: ${name}`);
      error.detail = detail;
      throw error;
    }
  };

  const fixtureFile = createFixtureFile();
  const { text: _generatedText, ...generatedMeta } = fixtureFile.generated;
  const meta = { path: E2E_PATH, ...generatedMeta };

  // Node 侧先确认夹具本身：合法、精确大小、跨过旧块与旧 8 MiB 边界。
  confirm("fixture: 精确 10174816 字节（约 9.7 MiB）", fixtureFile.bytes.length === TARGET_BYTES, {
    totalBytes: fixtureFile.bytes.length,
  });
  confirm("fixture: 395602 行（约 40 万行）", meta.lineCount === TARGET_LINES, {
    lineCount: meta.lineCount,
  });
  let jsonValid = true;
  try {
    JSON.parse(fixtureFile.text);
  } catch (error) {
    jsonValid = false;
    result.jsonError = String(error);
  }
  confirm("fixture: 内容是合法 JSON", jsonValid);
  confirm(
    "fixture: 左 token 本身横跨旧 262140 字节块边界",
    meta.boundary.leftStart < LEGACY_BLOCK_STEP &&
      meta.boundary.leftStart + TOKENS.boundaryLeft.length > LEGACY_BLOCK_STEP,
    meta.boundary,
  );
  confirm(
    "fixture: 右 token 起点在旧 262140 字节之后",
    meta.boundary.rightStart >= LEGACY_BLOCK_STEP,
    meta.boundary,
  );
  confirm(
    "fixture: 唯一 token 在旧 8 MiB 阈值之后",
    meta.pastEightMiB.offset > LEGACY_LARGE_FILE_BYTES,
    meta.pastEightMiB,
  );
  confirm(
    "fixture: 尾部 marker 位于最后一行数据行",
    meta.tail.lineNumber === meta.lineCount - 1,
    meta.tail,
  );

  let browser;
  let server;
  let buildDir;
  try {
    const playwright = await loadPlaywright();
    if (!playwright) {
      result.skipped = true;
      result.skipReason = "未加载 playwright-core；跳过隔离浏览器验证";
      return result;
    }
    const { chromium } = playwright;
    const executablePath = await findChromium(chromium.executablePath());
    if (!executablePath) {
      result.skipped = true;
      result.skipReason =
        "未找到独立 Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑完整正文编辑器验证";
      return result;
    }

    const { build } = await import("vite");
    buildDir = await mkdtemp(join(tmpdir(), "zcode-files-full-text-e2e-dist-"));
    result.buildDir = buildDir;
    await build({
      configFile: join(HERE, "vite.config.mts"),
      logLevel: "silent",
      build: { outDir: buildDir, emptyOutDir: true },
    });

    server = await startFixtureServer({ root: buildDir, fixture: fixtureFile, meta });
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}/`;
    result.origin = origin;

    const shotDir = await mkdtemp(join(tmpdir(), "zcode-files-full-text-e2e-shots-"));
    result.shotDir = shotDir;

    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => result.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") result.consoleErrors.push(message.text());
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        result.failedResources.push(`${response.status()} ${response.url()}`);
      }
    });

    const shot = async (name) => {
      const path = join(shotDir, `${name}.png`);
      await page.screenshot({ path, fullPage: false });
      result.screenshots.push(path);
      return path;
    };

    const waitFor = async (fn, label, timeout = 45_000) => {
      const started = Date.now();
      let lastError;
      while (Date.now() - started < timeout) {
        try {
          const value = await fn();
          if (value) return value;
        } catch (error) {
          lastError = error;
        }
        await page.waitForTimeout(100);
      }
      throw new Error(`等待超时: ${label}${lastError ? ` (${lastError})` : ""}`);
    };

    const snapshot = () => page.evaluate(() => window.__fullTextE2E.snapshot());
    const activeTextBuffer = async () => {
      const state = await snapshot();
      const buffer = state.buffers.find((candidate) => candidate.id === state.activeId);
      return buffer && buffer.kind === "text" ? buffer : undefined;
    };
    const mount = async (mode) => {
      await page.evaluate((value) => window.__fullTextE2E.mount({ mode: value }), mode);
      await page.waitForSelector('[data-files-e2e-ready="true"]', { timeout: 20_000 });
    };
    const openPath = async () => {
      await page.evaluate((path) => window.__fullTextE2E.openPath(path), E2E_PATH);
    };
    const monacoInfo = (tokens, lines = []) =>
      page.evaluate(
        ([tokenList, lineList]) => window.__fullTextE2E.monacoInfo(tokenList, lineList),
        [tokens, lines],
      );
    const bufferTokens = (tokens) =>
      page.evaluate((tokenList) => window.__fullTextE2E.bufferTokens(tokenList), tokens);
    const editorSnapshot = () => page.evaluate(() => window.__fullTextE2E.editorSnapshot());
    const focusEditor = () => page.evaluate(() => window.__fullTextE2E.focusEditor());

    await page.goto(origin, { waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean(window.__fullTextE2E?.mount), undefined, {
      timeout: 20_000,
    });

    const scenarioContext = {
      page,
      confirm,
      waitFor,
      shot,
      mount,
      openPath,
      activeTextBuffer,
      monacoInfo,
      bufferTokens,
      editorSnapshot,
      focusEditor,
      fixtureFile,
      meta,
      result,
    };
    const { expectedEditedLength } = await runEditorScenarios(scenarioContext);
    await runPersistenceScenarios(scenarioContext, { expectedEditedLength });

    // ------------------------------------------------------ 运行时错误汇总
    const ignoredConsoleErrors = result.consoleErrors.filter(
      (message) => !/favicon|Failed to load resource: the server responded with a status of 404/i.test(message),
    );
    const ignoredResources = result.failedResources.filter(
      (entry) => !/favicon|apple-touch-icon/i.test(entry),
    );
    confirm("runtime: pageerror 为空", result.pageErrors.length === 0, result.pageErrors);
    confirm("runtime: console.error 为空", ignoredConsoleErrors.length === 0, ignoredConsoleErrors);
    confirm("runtime: 没有 4xx/5xx 资源", ignoredResources.length === 0, ignoredResources);

    return result;
  } catch (error) {
    result.assertions.push({
      name: "执行异常",
      ok: false,
      detail:
        error?.detail ??
        String(error instanceof Error ? (error.stack ?? error.message) : error),
    });
    return result;
  } finally {
    await browser?.close().catch(() => {});
    await new Promise((resolveClose) => {
      if (!server) return resolveClose();
      server.close(() => resolveClose());
    });
    if (buildDir && process.env.FILES_FULL_TEXT_E2E_KEEP !== "1") {
      await rm(buildDir, { recursive: true, force: true }).catch(() => {});
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
