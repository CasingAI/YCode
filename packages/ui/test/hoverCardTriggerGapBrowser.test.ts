import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "playwright-core";

// 上下文用量浮层的真实浏览器回归：用实际 React Context 组件、编译后的 Tailwind CSS 和
// 复现 composer 紧包 span 的 fixture，验证 2px 留白、命中桥 border box 几何、慢速/斜向/返回、
// 碰撞翻转、邻近控件关闭以及裁剪父层负对照。只启动本测试自己的 headless Chromium 和临时
// profile，不连接或操作 YCode。规则见 docs/specs/hover-card-trigger-gap.md。

const desktopRequire = createRequire(new URL("../../desktop/package.json", import.meta.url));
const uiRoot = fileURLToPath(new URL("..", import.meta.url));
const contextModulePath = fileURLToPath(
  new URL("../src/components/ai-elements/context.tsx", import.meta.url),
);
const OPEN_PANEL_SELECTOR = '[data-slot="hover-card-content"][data-state="open"]';
const TRIGGER_SELECTOR = '[data-testid="trigger"]';
const WRAP_SELECTOR = '[data-testid="wrap"]';

interface FixtureOptions {
  size: 28 | 32;
  top: number;
  side: "top" | "bottom";
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

interface BridgeStyle {
  width: number;
  height: number;
  content: string;
  position: string;
}

async function findChromiumExecutable(bundledExecutable: string): Promise<string | undefined> {
  const macApplications = [resolve("/", "Applications"), join(homedir(), "Applications")];
  const windowsApplications = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.LOCALAPPDATA,
  ].filter((directory): directory is string => Boolean(directory));
  const candidates = [
    process.env.ZCODE_TEST_CHROMIUM_PATH,
    process.env.CHROME_BIN,
    process.env.CHROMIUM_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    bundledExecutable,
    ...macApplications.flatMap((directory) => [
      join(directory, "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      join(directory, "Chromium.app", "Contents", "MacOS", "Chromium"),
    ]),
    ...windowsApplications.flatMap((directory) => [
      join(directory, "Google", "Chrome", "Application", "chrome.exe"),
      join(directory, "Chromium", "Application", "chrome.exe"),
    ]),
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .flatMap((directory) =>
        ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"].map((name) =>
          join(directory, name),
        ),
      ),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 浏览器是可选的本地验证工具；没有安装时由测试显式 skip，不下载或安装。
    }
  }
}

async function resolveExistingSource(candidate: string): Promise<string | undefined> {
  const withoutJs = candidate.endsWith(".js") ? candidate.slice(0, -3) : candidate;
  for (const file of [
    ...[".ts", ".tsx", ".mjs", ".js", ".json"].map((extension) => `${withoutJs}${extension}`),
    candidate,
  ]) {
    try {
      await access(file);
      return file;
    } catch {
      // 源码使用 .js 导入扩展名；临时 fixture 打包时继续尝试 TypeScript 文件。
    }
  }
}

function createFixtureSource(wrapperClassName: string): string {
  const contextImport = JSON.stringify(contextModulePath.replace(/\\/g, "/"));
  return `
import { createRoot } from "react-dom/client";
import {
  CONTEXT_PANEL_TRIGGER_GAP_PX,
  Context,
  ContextContent,
  ContextTrigger,
} from ${contextImport};

const options = window.__YCODE_HOVER_FIXTURE__ ?? { size: 28, top: 300, side: "top" };

function Fixture() {
  return (
    <div
      style={{
        position: "fixed",
        left: 360,
        top: options.top,
        display: "flex",
        alignItems: "center",
        gap: 4,
      }}
    >
      <span
        data-testid="wrap"
        className={${JSON.stringify(wrapperClassName)}}
      >
        <Context usedTokens={10} maxTokens={100}>
          <span className="inline-flex shrink-0">
            <ContextTrigger
              hitBridge
              aria-label="context usage"
              data-testid="trigger"
              className={options.size === 32 ? "h-8 w-8" : undefined}
            />
          </span>
          <ContextContent
            side={options.side}
            sideOffset={CONTEXT_PANEL_TRIGGER_GAP_PX}
          >
            <div data-testid="panel-body" style={{ height: 80 }}>
              panel
            </div>
          </ContextContent>
        </Context>
      </span>
      <button
        type="button"
        data-testid="neighbor"
        style={{ width: 40, height: 28 }}
        onClick={() => {
          window.__neighborClicks = (window.__neighborClicks ?? 0) + 1;
        }}
      >
        N
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Fixture />);
`;
}

async function collectRenderedClassNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const names = new Set<string>();
    for (const element of document.querySelectorAll("[class]")) {
      for (const className of element.classList) names.add(className);
    }
    return [...names];
  });
}

async function createFixturePage(
  context: BrowserContext,
  bundlePath: string,
  options: FixtureOptions,
): Promise<{ page: Page; classNames: string[] }> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.setContent(
    '<!doctype html><html><head><script>globalThis.__name = (value) => value;</script></head><body style="margin:0"><div id="root"></div></body></html>',
  );
  await page.evaluate((value) => {
    (window as Window & { __YCODE_HOVER_FIXTURE__?: unknown }).__YCODE_HOVER_FIXTURE__ = value;
  }, options);
  await page.addScriptTag({ path: bundlePath });
  await page.waitForSelector(TRIGGER_SELECTOR);
  return { page, classNames: await collectRenderedClassNames(page) };
}

async function readTriggerRect(page: Page): Promise<Rect> {
  return page.evaluate((selector) => {
    const element = document.querySelector(selector) as HTMLElement;
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }, TRIGGER_SELECTOR);
}

async function readPanelRect(page: Page): Promise<Rect> {
  return page.evaluate((selector) => {
    const element = document.querySelector(selector) as HTMLElement;
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }, OPEN_PANEL_SELECTOR);
}

async function readBridgeStyle(page: Page, pseudo: "::before" | "::after"): Promise<BridgeStyle> {
  return page.evaluate(
    ({ selector, pseudoElement }) => {
      const element = document.querySelector(selector) as HTMLElement;
      const style = getComputedStyle(element, pseudoElement);
      return {
        width: Number.parseFloat(style.width),
        height: Number.parseFloat(style.height),
        content: style.content,
        position: style.position,
      };
    },
    { selector: TRIGGER_SELECTOR, pseudoElement: pseudo },
  );
}

async function openPanelAtTrigger(page: Page): Promise<Rect> {
  await page.mouse.move(2, 2);
  await page.waitForFunction((selector) => !document.querySelector(selector), OPEN_PANEL_SELECTOR, {
    timeout: 2_000,
  });
  const trigger = await readTriggerRect(page);
  await page.mouse.move(trigger.left + trigger.width / 2, trigger.top + trigger.height / 2);
  await page.waitForSelector(OPEN_PANEL_SELECTOR, { state: "attached", timeout: 2_000 });
  await page.waitForFunction(
    (selector) => {
      const element = document.querySelector(selector);
      return element !== null && getComputedStyle(element).visibility !== "hidden";
    },
    OPEN_PANEL_SELECTOR,
    { timeout: 2_000 },
  );
  return trigger;
}

async function isPanelOpen(page: Page): Promise<boolean> {
  return (await page.locator(OPEN_PANEL_SELECTOR).count()) === 1;
}

async function waitForPanelClosed(page: Page): Promise<void> {
  await page.waitForFunction((selector) => !document.querySelector(selector), OPEN_PANEL_SELECTOR, {
    timeout: 2_000,
  });
}

function centerOf(rect: Rect): Point {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

async function slowMove(page: Page, from: Point, to: Point, steps = 16, delay = 25): Promise<void> {
  for (let index = 1; index <= steps; index += 1) {
    const ratio = index / steps;
    await page.mouse.move(from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio);
    await page.waitForTimeout(delay);
  }
}

async function assertGapHoverSurvives(page: Page, direction: "up" | "down"): Promise<void> {
  const trigger = await openPanelAtTrigger(page);
  const panel = await readPanelRect(page);
  const start = centerOf(trigger);
  const target =
    direction === "up" ? { x: start.x, y: panel.bottom - 10 } : { x: start.x, y: panel.top + 10 };
  const gapPoint =
    direction === "up" ? { x: start.x, y: trigger.top - 1 } : { x: start.x, y: trigger.bottom + 1 };

  // 在留白中驻留：命中桥仍属于触发器，closeDelay=0 不应到点。
  await page.mouse.move(gapPoint.x, gapPoint.y);
  await page.waitForTimeout(150);
  assert.equal(await isPanelOpen(page), true, `${direction} 方向在留白中驻留时面板必须保持打开`);

  // 慢速穿越整段留白进入面板，再慢速返回触发器。
  await slowMove(page, start, target);
  assert.equal(await isPanelOpen(page), true, `${direction} 方向慢速进入面板时面板必须保持打开`);
  await slowMove(page, target, start);
  assert.equal(
    await isPanelOpen(page),
    true,
    `${direction} 方向从面板返回触发器时面板必须保持打开`,
  );
}

test(
  "真实 Chromium 验证上下文浮层 2px 留白、border box 命中桥与裁剪父层",
  { timeout: 60_000 },
  async (t) => {
    const startedAt = Date.now();
    const stage = (message: string) => {
      if (process.env.ZCODE_HOVER_GAP_DEBUG !== "1") return;
      process.stderr.write(`[hover-gap +${Date.now() - startedAt}ms] ${message}\n`);
    };
    // 只启动本测试自己的 headless Chromium 和全新 profile；不连接 YCode 或已有浏览器。
    const { chromium } = desktopRequire("playwright-core") as typeof import("playwright-core");
    const executablePath = await findChromiumExecutable(chromium.executablePath());
    if (!executablePath) {
      t.skip(
        "未找到独立 Chrome/Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑上下文命中桥浏览器回归",
      );
      return;
    }

    const [{ build: esbuild }, { compile }] = await Promise.all([
      import("esbuild"),
      import("@tailwindcss/node"),
    ]);
    const profileDirectory = await mkdtemp(join(tmpdir(), "ycode-hover-bridge-"));
    try {
      const fixtureDirectory = await mkdtemp(join(tmpdir(), "ycode-hover-fixture-"));
      try {
        const entryPath = join(fixtureDirectory, "entry.tsx");
        const bundlePath = join(fixtureDirectory, "fixture.js");
        const composerSource = await readFile(
          new URL("../src/v4/ConversationComposer.tsx", import.meta.url),
          "utf8",
        );
        // 从真实调用点提取父层类名，防止 fixture 保留正确裁剪而生产代码退回 overflow-hidden。
        const wrapperClassName = composerSource.match(
          /<span className="([^"]+)">\s*<V4ComposerModelControls\b/,
        )?.[1];
        assert.ok(wrapperClassName, "composer 必须保留可识别的模型控件父层");
        await writeFile(entryPath, createFixtureSource(wrapperClassName), "utf8");
        await esbuild({
          entryPoints: [entryPath],
          outfile: bundlePath,
          bundle: true,
          format: "iife",
          platform: "browser",
          jsx: "automatic",
          target: ["chrome120"],
          // fixture 位于系统临时目录，裸包名需要显式回退到仓库的 node_modules。
          nodePaths: [join(uiRoot, "node_modules"), join(uiRoot, "..", "..", "node_modules")],
          define: { "process.env.NODE_ENV": '"production"' },
          plugins: [
            {
              name: "resolve-ui-source",
              setup(build) {
                build.onResolve({ filter: /^@\// }, async (args) => {
                  const target = resolve(uiRoot, "src", args.path.slice(2));
                  const resolvedPath = await resolveExistingSource(target);
                  return resolvedPath ? { path: resolvedPath } : undefined;
                });
                build.onResolve({ filter: /\.js$/ }, async (args) => {
                  if (!args.path.startsWith(".")) return undefined;
                  const target = resolve(args.resolveDir, args.path);
                  const resolvedPath = await resolveExistingSource(target);
                  return resolvedPath ? { path: resolvedPath } : undefined;
                });
              },
            },
          ],
          logLevel: "silent",
        });

        const context = await chromium.launchPersistentContext(profileDirectory, {
          executablePath,
          headless: true,
          viewport: { width: 900, height: 700 },
        });
        try {
          stage("browser launched");
          const fixturePages: {
            options: FixtureOptions;
            page: Page;
            classNames: string[];
          }[] = [];
          for (const size of [28, 32] as const) {
            const options: FixtureOptions = { size, top: 300, side: "top" };
            const fixturePage = await createFixturePage(context, bundlePath, options);
            stage(`fixture size=${size} top=${options.top} rendered`);
            await openPanelAtTrigger(fixturePage.page);
            fixturePages.push({
              options,
              page: fixturePage.page,
              classNames: [
                ...fixturePage.classNames,
                ...(await collectRenderedClassNames(fixturePage.page)),
              ],
            });
          }
          for (const size of [28, 32] as const) {
            const options: FixtureOptions = { size, top: 12, side: "top" };
            const fixturePage = await createFixturePage(context, bundlePath, options);
            stage(`fixture size=${size} top=${options.top} rendered`);
            await openPanelAtTrigger(fixturePage.page);
            fixturePages.push({
              options,
              page: fixturePage.page,
              classNames: [
                ...fixturePage.classNames,
                ...(await collectRenderedClassNames(fixturePage.page)),
              ],
            });
          }
          stage("all fixtures opened and classes collected");

          const classNames = new Set<string>([
            "overflow-hidden",
            "overflow-x-clip",
            "overflow-y-visible",
          ]);
          for (const fixturePage of fixturePages) {
            for (const className of fixturePage.classNames) classNames.add(className);
          }
          const compiledCss = await compile('@import "tailwindcss";', {
            base: uiRoot,
            onDependency: () => undefined,
          }).then((compiler) => compiler.build([...classNames]));
          for (const fixturePage of fixturePages) {
            await fixturePage.page.addStyleTag({ content: compiledCss });
            await fixturePage.page.waitForTimeout(50);
          }
          stage("tailwind css injected");

          const diagnostics: string[] = [];
          const mainPages = fixturePages.filter((fixturePage) => fixturePage.options.top === 300);
          for (const fixturePage of mainPages) {
            const { page, options } = fixturePage;
            await page.bringToFront();
            stage(`main size=${options.size} start`);
            const trigger = await openPanelAtTrigger(page);
            const panel = await readPanelRect(page);
            stage(
              `main size=${options.size} panel open gap=${(trigger.top - panel.bottom).toFixed(2)}`,
            );
            const before = await readBridgeStyle(page, "::before");
            const after = await readBridgeStyle(page, "::after");
            const gap = trigger.top - panel.bottom;
            const hits = await page.evaluate(
              ({ selector, wrapSelector }) => {
                const triggerElement = document.querySelector(selector) as HTMLElement;
                const wrap = document.querySelector(wrapSelector) as HTMLElement;
                const rect = triggerElement.getBoundingClientRect();
                const hit = (x: number, y: number) =>
                  triggerElement.contains(document.elementFromPoint(x, y));
                const describe = (x: number, y: number) => {
                  const element = document.elementFromPoint(x, y);
                  if (!element) return "null";
                  return `${element.tagName}[data-slot=${element.getAttribute("data-slot") ?? ""}]`;
                };
                return {
                  pointerFine: window.matchMedia("(pointer: fine)").matches,
                  overflowX: getComputedStyle(wrap).overflowX,
                  overflowY: getComputedStyle(wrap).overflowY,
                  gapCenter: hit(rect.left + rect.width / 2, rect.top - 1),
                  // 用真实最外侧 1px 路径，避免 elementFromPoint 对半像素做取整。
                  gapLeftInside: hit(rect.left + 1, rect.top - 1),
                  gapLeftOutside: hit(rect.left - 1, rect.top - 1),
                  gapRightInside: hit(rect.right - 1, rect.top - 1),
                  gapRightOutside: hit(rect.right + 1, rect.top - 1),
                  leftOutsideElement: describe(rect.left - 1, rect.top - 1),
                  rightOutsideElement: describe(rect.right + 1, rect.top - 1),
                };
              },
              { selector: TRIGGER_SELECTOR, wrapSelector: WRAP_SELECTOR },
            );

            diagnostics.push(
              `size=${options.size} gap=${gap.toFixed(2)} before=${before.width}x${before.height} after=${after.width}x${after.height}`,
            );
            assert.equal(hits.pointerFine, true, "headless 浏览器必须匹配 pointer: fine");
            assert.equal(hits.overflowX, "clip", "紧包 span 必须保留 X 裁剪");
            assert.equal(hits.overflowY, "visible", "紧包 span 必须放开 Y 以便命中桥溢出");
            assert.equal(trigger.width, options.size, `触发器宽度应为 ${options.size}px`);
            assert.equal(trigger.height, options.size, `触发器高度应为 ${options.size}px`);
            assert.ok(Math.abs(gap - 2) <= 0.6, `面板与触发器的视觉留白应约为 2px，实际 ${gap}`);
            assert.equal(before.position, "absolute");
            assert.equal(after.position, "absolute");
            assert.notEqual(before.content, "none");
            assert.notEqual(after.content, "none");
            assert.ok(
              Math.abs(before.height - 3) <= 0.1,
              `before 高度应为 3px，实际 ${before.height}`,
            );
            assert.ok(
              Math.abs(after.height - 3) <= 0.1,
              `after 高度应为 3px，实际 ${after.height}`,
            );
            assert.ok(
              Math.abs(before.width - trigger.width) <= 0.6,
              `before 宽度应等于按钮 border box ${trigger.width}px，实际 ${before.width}`,
            );
            assert.ok(
              Math.abs(after.width - trigger.width) <= 0.6,
              `after 宽度应等于按钮 border box ${trigger.width}px，实际 ${after.width}`,
            );
            assert.equal(hits.gapCenter, true, "留白中点必须仍命中触发器");
            assert.equal(hits.gapLeftInside, true, "border box 左沿内 1px 必须命中命中桥");
            assert.equal(
              hits.gapLeftOutside,
              false,
              `border box 左沿外 1px 不得命中（实际命中 ${hits.leftOutsideElement}）`,
            );
            assert.equal(hits.gapRightInside, true, "border box 右沿内 1px 必须命中命中桥");
            assert.equal(
              hits.gapRightOutside,
              false,
              `border box 右沿外 1px 不得命中（实际命中 ${hits.rightOutsideElement}）`,
            );

            await assertGapHoverSurvives(page, "up");
            stage(`main size=${options.size} gap-survive ok`);

            // 最外侧 1px：贴着左右 border box 内沿穿越留白。
            for (const x of [trigger.left + 1, trigger.right - 1]) {
              await openPanelAtTrigger(page);
              const currentPanel = await readPanelRect(page);
              await slowMove(
                page,
                { x, y: trigger.top + trigger.height / 2 },
                { x, y: currentPanel.bottom - 10 },
              );
              assert.equal(
                await isPanelOpen(page),
                true,
                `沿 x=${x.toFixed(2)} 的外侧 1px 路径穿越留白时面板必须保持打开`,
              );
              await page.mouse.move(2, 2);
              await waitForPanelClosed(page);
            }
            stage(`main size=${options.size} outer-1px ok`);

            // 斜向穿越：上移同时向左偏移，路径在跨留白时仍留在触发器宽度内。
            // 偏移过大而先离开触发器侧沿的路径应关闭，属于既有语义（由邻近控件用例覆盖）。
            await openPanelAtTrigger(page);
            const diagonalPanel = await readPanelRect(page);
            const diagonalStart = centerOf(trigger);
            await slowMove(page, diagonalStart, {
              x: diagonalStart.x - 20,
              y: diagonalPanel.bottom - 10,
            });
            assert.equal(await isPanelOpen(page), true, "斜向穿越留白时面板必须保持打开");
            stage(`main size=${options.size} diagonal ok`);

            // 横向移向邻近控件：命中桥不横向扩张，面板关闭，邻近按钮仍可点击。
            await openPanelAtTrigger(page);
            const neighbor = await page.evaluate(() => {
              const element = document.querySelector('[data-testid="neighbor"]') as HTMLElement;
              const rect = element.getBoundingClientRect();
              return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
              };
            });
            await slowMove(page, centerOf(trigger), neighbor, 10, 30);
            await waitForPanelClosed(page);
            await page.locator('[data-testid="neighbor"]').click();
            assert.equal(
              await page.evaluate(
                () => (window as Window & { __neighborClicks?: number }).__neighborClicks ?? 0,
              ),
              1,
              "命中桥不得覆盖邻近控件",
            );
            stage(`main size=${options.size} neighbor ok`);

            // 裁剪父层负对照：改回 overflow-hidden 后，命中桥被裁掉，慢速穿越会关闭。
            await page.evaluate(
              ({ selector }) => {
                (document.querySelector(selector) as HTMLElement).className =
                  "flex min-w-0 shrink items-center gap-1 overflow-hidden empty:hidden";
              },
              { selector: WRAP_SELECTOR },
            );
            await page.waitForTimeout(50);
            const clippedTrigger = await openPanelAtTrigger(page);
            const clippedHits = await page.evaluate(
              ({ selector, wrapSelector }) => {
                const element = document.querySelector(selector) as HTMLElement;
                const wrap = document.querySelector(wrapSelector) as HTMLElement;
                const rect = element.getBoundingClientRect();
                return {
                  overflowY: getComputedStyle(wrap).overflowY,
                  gapCenter: element.contains(
                    document.elementFromPoint(rect.left + rect.width / 2, rect.top - 1),
                  ),
                };
              },
              { selector: TRIGGER_SELECTOR, wrapSelector: WRAP_SELECTOR },
            );
            assert.equal(clippedHits.overflowY, "hidden");
            assert.equal(clippedHits.gapCenter, false, "overflow-hidden 必须把命中桥裁掉");
            await page.mouse.move(
              clippedTrigger.left + clippedTrigger.width / 2,
              clippedTrigger.top - 1,
            );
            await page.waitForTimeout(150);
            assert.equal(
              await isPanelOpen(page),
              false,
              "负对照：裁剪父层下指针离开触发器后必须关闭",
            );
            await page.evaluate(
              ({ selector, className }) => {
                (document.querySelector(selector) as HTMLElement).className = className;
              },
              { selector: WRAP_SELECTOR, className: wrapperClassName },
            );
            await page.waitForTimeout(50);
            await assertGapHoverSurvives(page, "up");
            stage(`main size=${options.size} clip negative-control ok`);
          }

          // 碰撞翻转到下方：触发器贴近视口顶部，side=top 会被 Radix flip 到 bottom。
          const flipPages = fixturePages.filter((fixturePage) => fixturePage.options.top === 12);
          for (const fixturePage of flipPages) {
            const { page, options } = fixturePage;
            await page.bringToFront();
            stage(`flip size=${options.size} start`);
            const trigger = await openPanelAtTrigger(page);
            const side = await page.evaluate(
              (selector) =>
                (document.querySelector(selector) as HTMLElement).getAttribute("data-side"),
              OPEN_PANEL_SELECTOR,
            );
            assert.equal(side, "bottom", `size=${options.size} 应因碰撞翻转到下方`);
            const panel = await readPanelRect(page);
            const gap = panel.top - trigger.bottom;
            const after = await readBridgeStyle(page, "::after");
            const gapHits = await page.evaluate(
              ({ selector }) => {
                const element = document.querySelector(selector) as HTMLElement;
                const rect = element.getBoundingClientRect();
                const hit = (x: number, y: number) =>
                  element.contains(document.elementFromPoint(x, y));
                const describe = (x: number, y: number) => {
                  const hitElement = document.elementFromPoint(x, y);
                  if (!hitElement) return "null";
                  return `${hitElement.tagName}[data-slot=${hitElement.getAttribute("data-slot") ?? ""}]`;
                };
                return {
                  center: hit(rect.left + rect.width / 2, rect.bottom + 1),
                  leftInside: hit(rect.left + 1, rect.bottom + 1),
                  leftOutside: hit(rect.left - 1, rect.bottom + 1),
                  rightInside: hit(rect.right - 1, rect.bottom + 1),
                  rightOutside: hit(rect.right + 1, rect.bottom + 1),
                  leftOutsideElement: describe(rect.left - 1, rect.bottom + 1),
                  rightOutsideElement: describe(rect.right + 1, rect.bottom + 1),
                };
              },
              { selector: TRIGGER_SELECTOR },
            );
            diagnostics.push(
              `flip size=${options.size} gap=${gap.toFixed(2)} after=${after.width}x${after.height}`,
            );
            assert.ok(Math.abs(gap - 2) <= 0.6, `翻转后下方留白应约为 2px，实际 ${gap}`);
            assert.ok(
              Math.abs(after.width - trigger.width) <= 0.6,
              `翻转后 after 宽度应等于 border box ${trigger.width}px，实际 ${after.width}`,
            );
            assert.equal(gapHits.center, true, "翻转后留白中点必须命中命中桥");
            assert.equal(gapHits.leftInside, true);
            assert.equal(
              gapHits.leftOutside,
              false,
              `翻转后 border box 左沿外 1px 不得命中（实际命中 ${gapHits.leftOutsideElement}）`,
            );
            assert.equal(gapHits.rightInside, true);
            assert.equal(
              gapHits.rightOutside,
              false,
              `翻转后 border box 右沿外 1px 不得命中（实际命中 ${gapHits.rightOutsideElement}）`,
            );
            await assertGapHoverSurvives(page, "down");
            stage(`flip size=${options.size} ok`);
          }

          t.diagnostic(
            `Chromium ${context.browser()?.version() ?? "unknown"}; ${diagnostics.join("; ")}`,
          );
          stage("all assertions complete");
        } finally {
          await context.close();
        }
      } finally {
        await rm(fixtureDirectory, { recursive: true, force: true });
      }
    } finally {
      await rm(profileDirectory, { recursive: true, force: true });
    }
  },
);
