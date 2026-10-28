import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BrowserContext, Page } from "playwright-core";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { BackgroundBashCommandHeader } from "../src/app-shell/BackgroundBashOutputSidePane.js";

const uiRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceUrl = new URL("../src/app-shell/BackgroundBashOutputSidePane.tsx", import.meta.url);
const desktopRequire = createRequire(new URL("../../desktop/package.json", import.meta.url));

async function readSource(): Promise<string> {
  return (await readFile(sourceUrl, "utf8")).replace(/\r\n/g, "\n");
}

function renderHeader(command: string, cwd?: string): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        BackgroundBashCommandHeader,
        cwd === undefined ? { command } : { command, cwd },
      ),
    ),
  );
}

function headerTag(markup: string): string {
  const match = markup.match(/<header\b[^>]*>/);
  assert.ok(match, "命令区 header 应被渲染");
  return match[0];
}

function taggedTag(markup: string, testId: string, tag: string): string {
  const marker = `data-testid="${testId}"`;
  const markerIndex = markup.indexOf(marker);
  assert.ok(markerIndex >= 0, `${testId} 应被渲染`);
  const start = markup.lastIndexOf(`<${tag}`, markerIndex);
  const end = markup.indexOf(">", markerIndex);
  assert.ok(start >= 0 && end > markerIndex, `${testId} 标签应完整`);
  return markup.slice(start, end + 1);
}

test("命令区整体最多占面板内容高度 25%，超出部分由命令区自己纵向滚动", async () => {
  const markup = renderHeader("pnpm typecheck", "/repo");
  const tag = headerTag(markup);
  const classes = tag.match(/class="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];

  assert.ok(classes.includes("max-h-[25%]"), "命令区必须以 25% 为硬上限");
  assert.ok(classes.includes("min-h-0"), "命令区不能被 flex 最小尺寸撑开");
  assert.ok(classes.includes("overflow-y-auto"), "超出 25% 的命令必须区内滚动");
  assert.ok(classes.includes("shrink-0"), "命令区仍是不参与压缩的固定区域");
  assert.ok(!classes.includes("h-[25%]"), "短命令不能被强制占满 25%");
  assert.ok(!classes.includes("px-4"), "header 本体不承担水平内边距");
  assert.ok(
    !classes.includes("py-2.5"),
    "header 本体不承担垂直内边距，避免极矮面板的 padding floor",
  );
  assert.ok(
    markup.includes('<div class="flex min-w-0 flex-col gap-1 px-4 py-2.5">'),
    "内边距、间距与 cwd 必须放在 header 内部的滚动内容里",
  );

  assert.match(markup, /data-testid="background-bash-command"/);
  assert.match(markup, /data-testid="background-bash-cwd"/);
  assert.match(markup, /data-testid="background-bash-copy"/);
});

test("长命令完整渲染且换行，不截断命令文本或复制来源", async () => {
  const source = await readSource();
  const longCommand = `pnpm exec tsc --noEmit ${"continuous-segment-".repeat(512)}`;
  const markup = renderHeader(longCommand, "/repo");

  assert.ok(markup.includes(longCommand), "命令原文必须完整渲染");
  const command = taggedTag(markup, "background-bash-command", "p");
  assert.match(command, /whitespace-pre-wrap/);
  assert.match(command, /break-words/);
  assert.doesNotMatch(command, /truncate/);
  assert.doesNotMatch(markup, /…/);
  // 复制按钮拿到的是同一个完整 command，而不是可视区域或截断后的派生值。
  assert.match(source, /<CopyCommandButton text=\{command\} \/>/);
});

test("cwd 仍单行截断并保留完整 title", async () => {
  const cwd = `/repo/${"nested/".repeat(80)}package`;
  const markup = renderHeader("pnpm test", cwd);

  assert.ok(markup.includes(`title="${cwd}"`), "cwd 的完整路径必须留在 title");
  assert.match(taggedTag(markup, "background-bash-cwd", "p"), /truncate/);
});

test("输出区保留自己的滚动容器，命令区滚动不接管输出", async () => {
  const source = await readSource();

  assert.match(source, /data-testid="background-bash-scroll"/);
  assert.match(source, /className="relative min-h-0 flex-1"/);
  assert.match(source, /className="h-full overflow-auto px-4 py-3"/);
  assert.match(source, /data-testid="background-bash-output"/);
});

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
      // 浏览器可选的本地验证工具；缺失时由测试显式 skip，不下载或安装。
    }
  }
}

async function compileTailwindForMarkup(markup: string): Promise<string> {
  const classNames = new Set<string>();
  for (const match of markup.matchAll(/class="([^"]*)"/g)) {
    for (const className of match[1]!.split(/\s+/)) {
      if (className) classNames.add(className);
    }
  }
  const { compile } = await import("@tailwindcss/node");
  const compiler = await compile('@import "tailwindcss";', {
    base: uiRoot,
    onDependency: () => undefined,
  });
  return compiler.build([...classNames]);
}

function fixture(markup: string, paneHeight: number): string {
  return `<!doctype html><html><head><style>
    html, body { margin: 0; }
    #pane { display: flex; flex-direction: column; width: 100%; height: ${paneHeight}px; min-height: 0; overflow: hidden; }
  </style></head><body><section id="pane">${markup}</section></body></html>`;
}

async function createFixturePage(
  context: BrowserContext,
  markup: string,
  paneHeight: number,
  viewport: { width: number; height: number },
): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  await page.setContent(fixture(markup, paneHeight));
  await page.addStyleTag({ content: await compileTailwindForMarkup(markup) });
  return page;
}

async function readGeometry(page: Page) {
  return page.evaluate(() => {
    const pane = document.getElementById("pane") as HTMLElement;
    const header = document.querySelector("header") as HTMLElement;
    const inner = header.firstElementChild as HTMLElement;
    const command = document.querySelector(
      '[data-testid="background-bash-command"]',
    ) as HTMLElement;
    const cwd = document.querySelector('[data-testid="background-bash-cwd"]') as HTMLElement;
    const headerStyle = getComputedStyle(header);
    const innerStyle = getComputedStyle(inner);
    const paneRect = pane.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const innerRect = inner.getBoundingClientRect();
    const cwdRect = cwd.getBoundingClientRect();
    const beforeScroll = {
      cwdHeight: cwdRect.height,
      cwdBottom: cwdRect.bottom,
      headerBottom: headerRect.bottom,
    };
    header.scrollTop = header.scrollHeight;
    const scrolledHeaderRect = header.getBoundingClientRect();
    const scrolledCwdRect = cwd.getBoundingClientRect();

    return {
      paneHeight: paneRect.height,
      headerHeight: headerRect.height,
      headerMaxHeight: headerStyle.maxHeight,
      headerDisplay: headerStyle.display,
      headerPaddingTop: Number.parseFloat(headerStyle.paddingTop),
      headerPaddingBottom: Number.parseFloat(headerStyle.paddingBottom),
      headerMarginTop: Number.parseFloat(headerStyle.marginTop),
      headerMarginBottom: Number.parseFloat(headerStyle.marginBottom),
      innerPaddingTop: Number.parseFloat(innerStyle.paddingTop),
      innerPaddingBottom: Number.parseFloat(innerStyle.paddingBottom),
      innerHeight: innerRect.height,
      headerClientHeight: header.clientHeight,
      headerScrollHeight: header.scrollHeight,
      headerClientWidth: header.clientWidth,
      headerScrollWidth: header.scrollWidth,
      commandClientWidth: command.clientWidth,
      commandScrollWidth: command.scrollWidth,
      commandText: command.textContent ?? "",
      cwdText: cwd.textContent ?? "",
      cwdHeight: beforeScroll.cwdHeight,
      cwdVisibleBeforeScroll: beforeScroll.cwdBottom <= beforeScroll.headerBottom + 1,
      cwdVisibleAfterScroll:
        scrolledCwdRect.height > 0 && scrolledCwdRect.bottom <= scrolledHeaderRect.bottom + 1,
      scrollTopAfterScroll: header.scrollTop,
    };
  });
}

test(
  "真实 Chromium 验证命令区 25% 高度上限、短命令自然高度与极矮面板滚动",
  { timeout: 60_000 },
  async (t) => {
    const { chromium } = desktopRequire("playwright-core") as typeof import("playwright-core");
    const executablePath = await findChromiumExecutable(chromium.executablePath());
    if (!executablePath) {
      t.skip("未找到独立 Chrome/Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑盒模型回归");
      return;
    }

    const shortCommand = "pnpm typecheck";
    const longCommand = Array.from({ length: 40 }, (_, index) => `echo line-${index}`).join("\n");
    const cwd = `/repo/${"nested/".repeat(40)}package`;
    const profileDirectory = await mkdtemp(join(tmpdir(), "ycode-background-bash-header-"));
    try {
      const context = await chromium.launchPersistentContext(profileDirectory, {
        executablePath,
        headless: true,
        viewport: { width: 900, height: 700 },
      });
      try {
        const shortPage = await createFixturePage(context, renderHeader(shortCommand, cwd), 400, {
          width: 900,
          height: 700,
        });
        const short = await readGeometry(shortPage);
        assert.equal(short.paneHeight, 400);
        assert.equal(short.headerPaddingTop, 0, "header 本体不得有垂直 padding");
        assert.equal(short.headerPaddingBottom, 0, "header 本体不得有垂直 padding");
        assert.equal(short.innerPaddingTop, 10, "内边距应位于内部滚动内容上");
        assert.equal(short.innerPaddingBottom, 10, "内边距应位于内部滚动内容上");
        assert.equal(short.headerMaxHeight, "25%", "命令区上限必须来自面板内容高度的 25%");
        assert.ok(
          short.headerHeight < 100,
          `短命令必须保持自然高度而不是占满 25%，实际 ${short.headerHeight}`,
        );
        assert.ok(
          Math.abs(short.headerHeight - short.innerHeight) <= 1,
          "短命令的 header 高度应与内容自然高度一致",
        );
        assert.ok(
          short.headerScrollHeight <= short.headerClientHeight + 1,
          "短命令不应出现内部滚动",
        );
        assert.ok(short.cwdHeight > 0 && short.cwdVisibleBeforeScroll, "短命令下 cwd 应完整可见");
        assert.equal(short.commandText, shortCommand);

        const narrowPage = await createFixturePage(context, renderHeader(longCommand, cwd), 400, {
          width: 360,
          height: 700,
        });
        const narrow = await readGeometry(narrowPage);
        assert.equal(narrow.paneHeight, 400);
        assert.equal(narrow.headerPaddingTop, 0);
        assert.equal(narrow.headerPaddingBottom, 0);
        assert.notEqual(narrow.headerDisplay, "flex", "header 不用 flex 列，避免压缩 cwd 行");
        assert.ok(
          Math.abs(narrow.headerHeight - 100) <= 1,
          `长命令应被限制在 25%，实际 ${narrow.headerHeight}`,
        );
        assert.ok(
          narrow.headerScrollHeight > narrow.headerClientHeight,
          "长命令必须由 header 自己纵向滚动",
        );
        assert.ok(narrow.scrollTopAfterScroll > 0, "长命令必须能滚动到内容末尾");
        assert.ok(
          narrow.headerScrollWidth <= narrow.headerClientWidth + 1,
          `360px 下不得出现横向溢出：${narrow.headerScrollWidth} > ${narrow.headerClientWidth}`,
        );
        assert.ok(
          narrow.commandScrollWidth <= narrow.commandClientWidth + 1,
          `长命令应换行而不是横向溢出：${narrow.commandScrollWidth} > ${narrow.commandClientWidth}`,
        );
        assert.equal(narrow.commandText, longCommand, "命令原文不得被改写");
        assert.equal(narrow.cwdText, cwd, "cwd 文本不得被改写");
        assert.ok(narrow.cwdHeight >= 12, `cwd 行不得被压扁，实际 ${narrow.cwdHeight}px`);
        assert.ok(narrow.cwdVisibleAfterScroll, "滚动到底后 cwd 行应可查看");

        const tinyPage = await createFixturePage(context, renderHeader(longCommand, cwd), 40, {
          width: 360,
          height: 700,
        });
        const tiny = await readGeometry(tinyPage);
        assert.equal(tiny.paneHeight, 40);
        assert.equal(tiny.headerPaddingTop, 0, "40px 面板下 header 仍不得有 padding floor");
        assert.equal(tiny.headerPaddingBottom, 0, "40px 面板下 header 仍不得有 padding floor");
        assert.equal(tiny.headerMarginTop, 0);
        assert.equal(tiny.headerMarginBottom, 0);
        assert.equal(tiny.headerMaxHeight, "25%", "极矮面板也必须使用同一个 25% 上限");
        assert.ok(
          tiny.headerHeight <= 10.5,
          `40px 面板下命令区不得超过 10px，实际 ${tiny.headerHeight}`,
        );
        assert.ok(tiny.headerHeight > 0, "极矮面板下命令区仍保留可滚动区域");
        assert.ok(
          tiny.headerScrollHeight > tiny.headerClientHeight,
          "极矮面板下内容必须能在 header 内滚动",
        );
        assert.ok(tiny.scrollTopAfterScroll > 0, "极矮面板下必须能滚动查看内容末尾");
        assert.ok(tiny.cwdHeight > 0, "极矮面板下 cwd 行也不得被压扁为零");
        assert.ok(tiny.cwdVisibleAfterScroll, "极矮面板下滚动到底后 cwd 行应可查看");
      } finally {
        await context.close();
      }
    } finally {
      await rm(profileDirectory, { recursive: true, force: true });
    }
  },
);
