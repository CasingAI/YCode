import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const desktopRequire = createRequire(new URL("../../desktop/package.json", import.meta.url));
const uiRoot = fileURLToPath(new URL("..", import.meta.url));
const sourcePath = (name: string) => JSON.stringify(join(uiRoot, "src", name).replace(/\\/g, "/"));

async function findChromium(bundledPath: string): Promise<string | undefined> {
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
    ...[resolve("/", "Applications"), join(homedir(), "Applications")].flatMap((directory) => [
      join(directory, "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      join(directory, "Chromium.app", "Contents", "MacOS", "Chromium"),
    ]),
    ...directories.flatMap((directory) => [
      join(directory, "Google", "Chrome", "Application", "chrome.exe"),
      join(directory, "Chromium", "Application", "chrome.exe"),
    ]),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
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
}

function fixtureSource(statusClass: string, triggerClass: string): string {
  return `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationTurnInfoAction } from ${sourcePath("v4/ConversationTurnInfoAction.tsx")};
import { ZCodeIntlProvider } from ${sourcePath("i18n/IntlProvider.tsx")};
import { TooltipProvider } from ${sourcePath("components/ui/tooltip.tsx")};
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from ${sourcePath("components/ui/collapsible.tsx")};

const base = {
  key: "browser-segment",
  flowItems: [], assistantWorkRows: [], assistantHistoryRows: [], assistantFollowingRows: [],
  assistantHistoryDefaultOpen: false,
};
function Fixture() {
  const [unknown, setUnknown] = useState(false);
  const [locale, setLocale] = useState("zh-CN");
  const segment = unknown ? {
    ...base, usage: { toolCallCount: 0, reasoningDurationMs: 0 },
    workStatus: { state: "interrupted" },
  } : {
    ...base, usage: { toolCallCount: 34, reasoningDurationMs: 39000 },
    workStatus: { state: "completed", durationMs: 3261000 },
    executionModels: [
      { providerId: "cliproxy-codex", modelId: "gpt-6-luna" },
      { providerId: "provider-b", modelId: "gpt-6-luna" },
      { providerId: "provider-" + "p".repeat(90), modelId: "model-" + "m".repeat(100) },
    ],
  };
  return <ZCodeIntlProvider key={locale} initialLocale={locale}><TooltipProvider>
    <main className="mx-auto w-full max-w-3xl p-4">
      <button data-testid="switch-scenario" onClick={() => setUnknown(value => !value)}>Switch scenario</button>
      <button data-testid="switch-locale" onClick={() => setLocale(value => value === "zh-CN" ? "en-US" : "zh-CN")}>Switch locale</button>
      <p>Current binding: commandcode / deepseek/deepseek-v4.1-flash</p>
      <Collapsible>
        <div data-testid="status-row" className={${JSON.stringify(statusClass)}}>
          <CollapsibleTrigger asChild><button data-testid="history" className={${JSON.stringify(triggerClass)}}>
            <span className="truncate">已工作 54 分 21 秒</span>
            <span className="shrink-0 text-ui-sm">· 工具 34 次 · 思考 39 秒</span>
          </button></CollapsibleTrigger>
          <ConversationTurnInfoAction segment={segment} turnId={"turn-" + "t".repeat(100)} className="ml-auto shrink-0" />
        </div>
        <CollapsibleContent>History details</CollapsibleContent>
      </Collapsible>
    </main>
  </TooltipProvider></ZCodeIntlProvider>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;
}

async function resolveSource(candidate: string): Promise<string | undefined> {
  const stem = candidate.endsWith(".js") ? candidate.slice(0, -3) : candidate;
  for (const file of [candidate, ...[".ts", ".tsx", ".js", ".json"].map((ext) => `${stem}${ext}`)]) {
    try {
      await access(file);
      return file;
    } catch {
      // 源码的 .js 导入在隔离 fixture 中解析到对应 TypeScript 文件。
    }
  }
}

test("独立浏览器验证回复信息打开、关闭、焦点与窄屏布局", { timeout: 90_000 }, async (t) => {
  // 只启动本测试自己的 Chromium 与临时 profile，不连接或操作正在运行的 YCode。
  const { chromium } = desktopRequire("playwright-core") as typeof import("playwright-core");
  const executablePath = await findChromium(chromium.executablePath());
  if (!executablePath) {
    t.skip("未找到独立 Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑回复信息交互测试");
    return;
  }
  const [{ build }, { compile }] = await Promise.all([import("esbuild"), import("@tailwindcss/node")]);
  const group = await readFile(new URL("../src/v4/ConversationTurnGroup.tsx", import.meta.url), "utf8");
  const statusSource = group.slice(group.indexOf("function AssistantHistoryStatus"), group.indexOf("function ConversationWorkSegmentFlow"));
  const statusClass = statusSource.match(/data-flow-gap="true"\s+className="([^"]+)"/)?.[1];
  const triggerClass = statusSource.match(/"(group\/history-message [^"]+)"/)?.[1];
  assert.ok(statusClass);
  assert.ok(triggerClass);
  const directory = await mkdtemp(join(tmpdir(), "ycode-turn-info-browser-"));
  try {
    const entry = join(directory, "entry.tsx");
    const bundle = join(directory, "fixture.js");
    await writeFile(entry, fixtureSource(statusClass, triggerClass));
    await build({
      entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
      jsx: "automatic", target: ["chrome120"], logLevel: "silent",
      nodePaths: [join(uiRoot, "node_modules"), join(uiRoot, "..", "..", "node_modules")],
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{
        name: "ui-source",
        setup(builder) {
          builder.onResolve({ filter: /^@\// }, async (args) => {
            const path = await resolveSource(resolve(uiRoot, "src", args.path.slice(2)));
            return path ? { path } : undefined;
          });
          builder.onResolve({ filter: /\.js$/ }, async (args) => {
            if (!args.path.startsWith(".")) return undefined;
            const path = await resolveSource(resolve(args.resolveDir, args.path));
            return path ? { path } : undefined;
          });
        },
      }],
    });
    const context = await chromium.launchPersistentContext(join(directory, "profile"), {
      executablePath, headless: true, viewport: { width: 1000, height: 760 },
    });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setContent('<!doctype html><html><head><script>globalThis.__name = value => value;</script></head><body><div id="root"></div></body></html>');
      await page.addScriptTag({ path: bundle });
      const trigger = page.getByRole("button", { name: "回复信息", exact: true });
      const dialog = page.getByRole("dialog");
      await trigger.click();
      await dialog.waitFor({ state: "visible" });
      const classes = await page.evaluate(() => [...new Set([...document.querySelectorAll("[class]")].flatMap((element) => [...element.classList]))]);
      const sourceCss = await readFile(join(uiRoot, "src", "styles.css"), "utf8");
      const compiler = await compile(sourceCss, { base: join(uiRoot, "src"), onDependency: () => undefined });
      await page.addStyleTag({ content: compiler.build(classes) });
      await page.addStyleTag({ content: "html,body{margin:0;background:var(--color-background);color:var(--color-foreground)}" });

      const text = await dialog.innerText();
      assert.ok(text.includes("cliproxy-codex") && text.includes("provider-b"));
      assert.equal(text.includes("commandcode"), false);
      assert.equal(text.includes("deepseek"), false);
      assert.equal(await page.getByTestId("history").getAttribute("data-state"), "closed");
      assert.equal(await dialog.locator("button button").count(), 0);

      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await trigger.evaluate((element) => document.activeElement === element), true);
      await trigger.press("Enter");
      await dialog.waitFor({ state: "visible" });
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await trigger.evaluate((element) => document.activeElement === element), true);

      for (const width of [1000, 375]) {
        await page.setViewportSize({ width, height: 760 });
        for (const dark of [false, true]) {
          await page.evaluate((value) => {
            document.documentElement.className = value ? "dark theme-zai-dark" : "theme-zai-light";
          }, dark);
          await trigger.click();
          await dialog.waitFor({ state: "visible" });
          const geometry = await dialog.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, viewport: innerWidth, scroll: element.scrollWidth, client: element.clientWidth };
          });
          assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewport, JSON.stringify(geometry));
          assert.ok(geometry.scroll <= geometry.client + 1, JSON.stringify(geometry));
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
        }
      }
      await trigger.click();
      await dialog.waitFor({ state: "visible" });
      await page.mouse.click(2, 2);
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await page.getByTestId("history").getAttribute("data-state"), "closed");
      const bar = await page.getByTestId("status-row").boundingBox();
      const icon = await trigger.boundingBox();
      assert.ok(bar && icon && icon.x + icon.width <= bar.x + bar.width + 1);

      await page.getByTestId("switch-scenario").click();
      await trigger.click();
      await dialog.waitFor({ state: "visible" });
      const unknownText = await dialog.innerText();
      assert.ok(unknownText.includes("未知") && unknownText.includes("0 秒"));
      assert.equal(unknownText.includes("cliproxy-codex"), false);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await page.getByTestId("switch-locale").click();
      await page.getByRole("button", { name: "Reply info", exact: true }).click();
      await dialog.waitFor({ state: "visible" });
      assert.ok((await dialog.innerText()).includes("Unknown"));
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
