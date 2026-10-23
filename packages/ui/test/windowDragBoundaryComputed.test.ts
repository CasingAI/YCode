import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import {
  resolveWorkspaceShellFilesSurfaceClassName,
  resolveWorkspaceShellTasksKeepaliveClassName,
  resolveWorkspaceSidebarPrimaryPaneClassName,
} from "../src/app-shell/workspaceShellResponsiveLayout.js";

const desktopRequire = createRequire(new URL("../../desktop/package.json", import.meta.url));

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

function fixture(boundaryCss: string, hiddenClassName: string): string {
  return `<!doctype html><html><head><style>
    body { margin: 0; }
    #shell { position: relative; width: 800px; height: 400px; }
    .absolute { position: absolute; } .inset-0 { inset: 0; }
    .pointer-events-none { pointer-events: none; } .opacity-0 { opacity: 0; }
    .z-0 { z-index: 0; }
    [data-drag] { app-region: drag; }
    [data-no-drag] { app-region: no-drag; }
    #files { position: absolute; inset: 0; z-index: 10; background: white; app-region: no-drag; }
    #tab { position: absolute; left: 200px; top: 4px; width: 120px; height: 36px; }
    #early-drag { position: absolute; left: 120px; top: 4px; width: 20px; height: 40px; }
    #hidden { position: absolute; inset: 0; app-region: no-drag; }
    #header { position: absolute; left: 160px; top: 0; width: 500px; height: 48px; }
    #header-button { position: absolute; right: 0; top: 8px; width: 28px; height: 28px; }
    #side-pane { position: absolute; left: 660px; top: 0; width: 140px; height: 48px; }
    #breadcrumb { position: absolute; left: 160px; top: 48px; width: 500px; height: 28px; }
    #inline-drag { position: absolute; left: 160px; top: 80px; width: 500px; height: 20px; }
    #inline-no-drag { position: absolute; left: 700px; top: 80px; width: 28px; height: 20px; }
    #top-overlay { position: absolute; inset: 0; z-index: 20; pointer-events: none; }
    #left-drag { position: absolute; left: 96px; top: 4px; width: 20px; height: 40px; }
    ${boundaryCss}
  </style></head><body><main id="shell">
    <section id="files"><button id="tab" data-no-drag>file.ts</button><div id="early-drag" data-drag></div></section>
    <section id="hidden" class="${hiddenClassName}" aria-hidden="true" inert>
      <header id="header" data-drag><span id="header-title">Task</span><button id="header-button" data-no-drag>Menu</button></header>
      <aside id="side-pane" data-drag><span id="side-pane-title">Side pane</span></aside>
      <nav id="breadcrumb" data-drag><span id="breadcrumb-title">Breadcrumb</span></nav>
      <div id="inline-drag" style="app-region: drag"><span id="inline-drag-child">Inline drag</span></div>
      <div id="inline-no-drag" style="app-region: no-drag">Inline no-drag</div>
    </section>
    <div id="top-overlay"><div id="left-drag" data-drag></div></div>
    <div id="initial-probe" style="app-region: initial"></div>
    <div id="none-probe" style="app-region: none"></div>
  </main></body></html>`;
}

test(
  "真实 Chromium 验证隐藏子树禁用原生 drag，保留可见左侧小拖动区并能恢复",
  { timeout: 30_000 },
  async (t) => {
    // 只启动本测试自己的 headless Chromium 和全新 profile；不连接 YCode 或已有浏览器。
    const { chromium } = desktopRequire("playwright-core") as typeof import("playwright-core");
    const executablePath = await findChromiumExecutable(chromium.executablePath());
    if (!executablePath) {
      t.skip(
        "未找到独立 Chrome/Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑 computed CSS 回归",
      );
      return;
    }

    const sourceCss = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
    // 直接加载源文件中的完整规则，避免在 fixture 中复制修复后得到自证测试。
    const boundaryCss =
      sourceCss.match(
        /\.window-drag-disabled\s*,\s*\.window-drag-disabled\s+\*\s*\{[^{}]*\}/,
      )?.[0] ?? "";
    const profileDirectory = await mkdtemp(join(tmpdir(), "ycode-window-drag-css-"));
    try {
      const context = await chromium.launchPersistentContext(profileDirectory, {
        executablePath,
        headless: true,
        viewport: { width: 800, height: 400 },
      });
      try {
        const page = await context.newPage();
        await page.setContent(
          fixture(boundaryCss, "pointer-events-none absolute inset-0 z-0 opacity-0"),
        );

        const readRegions = () =>
          page.evaluate(() => {
            const hidden = document.getElementById("hidden")!;
            const shell = document.getElementById("shell")!;
            const geometry = {
              region(element: Element) {
                return getComputedStyle(element).getPropertyValue("app-region");
              },
              center(id: string) {
                const rect = document.getElementById(id)!.getBoundingClientRect();
                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
              },
              // Chromium 先序遍历 layout box；Electron 对 drag/no-drag 矩形依次 union/difference。
              // 此处仅合成矩形归属，不能替代 Electron 原生鼠标命中或真实应用 E2E。
              synthesizedDraggableAt(point: { x: number; y: number }) {
                let draggable = false;
                for (const element of [shell, ...shell.querySelectorAll("*")]) {
                  const style = getComputedStyle(element);
                  const value = geometry.region(element);
                  if (style.visibility !== "visible" || (value !== "drag" && value !== "no-drag"))
                    continue;
                  const rect = element.getBoundingClientRect();
                  if (
                    rect.width > 0 &&
                    rect.height > 0 &&
                    point.x >= rect.left &&
                    point.x < rect.right &&
                    point.y >= rect.top &&
                    point.y < rect.bottom
                  ) {
                    draggable = value === "drag";
                  }
                }
                return draggable;
              },
            };
            return {
              hiddenRegions: Object.fromEntries(
                [hidden, ...hidden.querySelectorAll("*")].map((element) => [
                  element.id,
                  geometry.region(element),
                ]),
              ),
              opacity: getComputedStyle(hidden).opacity,
              pointerEvents: getComputedStyle(hidden).pointerEvents,
              inert: hidden.hasAttribute("inert"),
              leftDrag: geometry.region(document.getElementById("left-drag")!),
              tabPointDraggable: geometry.synthesizedDraggableAt(geometry.center("tab")),
              leftPointDraggable: geometry.synthesizedDraggableAt(geometry.center("left-drag")),
              earlyPointDraggable: geometry.synthesizedDraggableAt(geometry.center("early-drag")),
              initial: geometry.region(document.getElementById("initial-probe")!),
              none: geometry.region(document.getElementById("none-probe")!),
              defaultValue: geometry.region(shell),
              supportsNone: CSS.supports("app-region", "none"),
            };
          });

        // 负对照还原旧结构：即使透明、不可交互且根为 no-drag，显式子 drag 仍会重加原生区域。
        const original = await readRegions();
        assert.equal(original.opacity, "0");
        assert.equal(original.pointerEvents, "none");
        assert.equal(original.inert, true);
        assert.equal(original.hiddenRegions.hidden, "no-drag");
        assert.equal(original.hiddenRegions.header, "drag");
        assert.equal(original.hiddenRegions["side-pane"], "drag");
        assert.equal(original.hiddenRegions.breadcrumb, "drag");
        assert.equal(original.hiddenRegions["inline-drag"], "drag");
        assert.equal(original.tabPointDraggable, true);
        assert.equal(original.earlyPointDraggable, false);
        t.diagnostic(
          `Chromium ${context.browser()!.version()}; app-region default=${original.defaultValue}, initial=${original.initial}, none=${original.none}, supports(none)=${original.supportsNone}; old root-only Tab point=true (synthetic)`,
        );

        const hiddenClasses = [
          resolveWorkspaceShellTasksKeepaliveClassName({
            isSettingsPrimaryView: false,
            isFilesPrimaryView: true,
          }),
          resolveWorkspaceShellTasksKeepaliveClassName({ isSettingsPrimaryView: true }),
          resolveWorkspaceShellFilesSurfaceClassName({ isFilesPrimaryView: false }),
          resolveWorkspaceSidebarPrimaryPaneClassName({ isActive: false }),
        ];
        for (const className of hiddenClasses) {
          await page.evaluate((value) => {
            document.getElementById("hidden")!.className = value;
          }, className);
          const disabled = await readRegions();
          for (const [id, value] of Object.entries(disabled.hiddenRegions)) {
            assert.equal(value, "none", `${id} must emit no drag region under ${className}`);
          }
          assert.equal(disabled.leftDrag, "drag");
          assert.equal(
            disabled.tabPointDraggable,
            false,
            "hidden descendants must not re-add the Tab point (synthetic)",
          );
          assert.equal(
            disabled.leftPointDraggable,
            true,
            "global overlay comes last and preserves its small drag region",
          );
          assert.equal(
            disabled.earlyPointDraggable,
            true,
            "hidden initial boundary must not subtract an earlier visible drag region",
          );

          await page.evaluate(() =>
            document.getElementById("hidden")!.classList.remove("window-drag-disabled"),
          );
          const restored = await readRegions();
          assert.deepEqual(restored.hiddenRegions, original.hiddenRegions);
          assert.equal(restored.tabPointDraggable, true);
          assert.equal(restored.leftDrag, "drag");
        }
      } finally {
        await context.close();
      }
    } finally {
      await rm(profileDirectory, { recursive: true, force: true });
    }
  },
);
